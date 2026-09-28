// 启动面（boot surface）的类型契约 —— 组装根侧（bootstrap）。
//
// 依据 docs/design/boot-surface.md §2.4。本文件只有类型，零运行时代码：
//   · `BootStep` / `FailurePolicy`：冷启动 DAG 的节点形状（§2.4.1）
//   · `BootContext`：步骤之间传数据的**唯一通道**（§2.4.3）
//   · `BootPaths`：路径解析的产物（§2.4.4，把散在 assemble.ts 三处的解析收成一处纯函数）
//   · `BootPlan`：扫描 + 校验 + 拓扑排序的产物
//   · `KernelRuntimeState`：运行期可变状态的持有者（§2.4.3 生命周期界定的另一半）
//
// **为什么 `BootOp` / `runOps` 不在这里**：操作表要住内层（`application/lifecycle/boot-ops.ts`），
// 否则内层的插件操作表就得 import `bootstrap`（外层）——反向依赖。所以 `BootOp.run` 吃泛型 deps、
// 不认识 `BootContext`；本文件也不 import `boot-ops` 的操作类型，只 import 它的依赖形状
// （`KernelBootDeps` 住在同层的 `./ops`，见该文件）。
//
// **命名纪律**：本层的裸 `ctx` 一律指 `BootContext`。`MainContext`（运行期）与
// `KernelPluginContext`（内核插件工厂拿到的）是另外两个不同的 ctx，引用时写全名。
import type { Server } from "node:http";
import type { Host, KernelPlugin } from "@my-harness-desktop/shared";
import type { JsonPrefsStore } from "../../application/config/json-prefs";
import type { ConfigStore } from "../../application/config/config-store";
import type { PluginRegistry } from "../../application/loader/registry";
import type { I18nResource } from "../../application/i18n/merge";
import type { SessionStore } from "../../application/sessions/session-store";
import type { SessionBus } from "../../application/sessions/session-bus";
import type { RestartCoordinatorImpl } from "../../application/restart/restart-coordinator";
import type { PluginLifecycleDeps } from "../../application/lifecycle";
import type { MainContext, Prefs } from "../../application/context/main-context";
import type { KernelRegistry } from "../../kernel/core/kernel-registry";
import type { KernelAccessors } from "./kernel-accessors";
import type { KernelPluginLoader } from "./kernel-plugin-loading";
import type { KernelSurfaces } from "../kernel-surfaces";
import type { Gateway } from "../../routing/gateway";
import type { WsServerHandle } from "../../transport/ws/ws-server";
import type { RemoteConfigStore } from "../../remote/remote-config";
import type { RemoteAuth } from "../../remote/auth";
import type { KernelBootDeps } from "./ops";
import type { KernelLateRefs } from "./late-refs";

// ============ 步骤（冷启动 DAG 的节点） ============

/** 步骤级失败策略（§4.3）。**只管"run 整体抛出"**；实体级失败一律在 `runOps` 内部降级。
 *
 *  三者的区别必须钉死（都不阻断启动，但语义不同）：
 *  - `fatal`：抛出即中止后续步骤并冒泡到入口（壳起不来是正确的）；
 *  - `degrade`：**await 完成**，失败留痕后继续下一步（后续步骤可以依赖它的产物）；
 *  - `background`：**不 await**，结果稍后到达、靠回调广播（后续步骤不能依赖它）。 */
export type FailurePolicy = "fatal" | "degrade" | "background";

/** 一个启动步骤：DAG 的节点。真扫描装载，故必须**自包含**（不 import 其他 step，§3.4.2）。 */
export interface BootStep {
  /** 唯一 id = 构建产物文件名去掉 `.js`（含数字前缀），同时是 `requires` 的引用键。
   *  例：文件 `75-plugin-boot.ts` → 产物 `75-plugin-boot.js` → id `"75-plugin-boot"`。
   *  前缀承担三个职责：目录列表的可读顺序、拓扑排序的 tie-break、构建产物文件名——
   *  三者用同一个字符串，就不会出现"文件名说一个顺序、id 说另一个顺序"的漂移。 */
  id: string;
  /** `global` = 整个壳执行一次；`per-entity` = 内部经 `runOps` 遍历注册表、
   *  对每个实体调用同一张操作表。不参与调度，但决定失败留痕的粒度（§4.3.2）
   *  与守卫的检查方式（§6.2.2：per-entity 步骤必经 `runOps`，不许自写实体遍历）。 */
  scope: "global" | "per-entity";
  /** 硬前置：这些 step 必须先成功。未知 id → §3.2.2 校验抛错；成环 → §3.2.3 排序抛错。
   *  ⚠ 语义约束**必须**写成边，不能靠 id 字典序 tie-break 兜（§3.2.3 末尾：
   *  把 `90-transport` 改名成 `68-transport` 就会翻转顺序）。 */
  requires?: string[];
  /** 步骤级失败策略（见 `FailurePolicy`）。 */
  failure: FailurePolicy;
  run(ctx: BootContext): Promise<void> | void;
}

// ============ 路径（§2.4.4：一处纯函数解析，dev/打包态分流） ============

/** 启动所需的全部路径。**由 `resolveBootPaths(isPackaged)` 一处产出**（纯函数，可裸单测），
 *  取代今天散在 `assemble.ts` 三处（L85-102 / L145-157 / L190-203）的解析。
 *
 *  适配扩展的源路径（pi 侧 `packages/my-harness-fit-pi-extension`、dsh 侧
 *  `kernel/dsh/extension/dsh-extension`）**不在这里**——它们由各内核插件自己按 `isPackaged`
 *  分流解析（`kernel/pi/plugin.ts:127-130`、`kernel/dsh/plugin.ts:146-152`）。
 *  这是 `CLAUDE.md` §1.6 的要求：内核专属资产路径是内核的私有知识，壳不持有。 */
export interface BootPaths {
  /** 家目录（`homedir()`）。**列进路径表而不是让步骤自己读 `os.homedir()`**：
   *  内核插件上下文（`KernelPluginContext.homedir`）与 `MainContext.paths.homeDir` 都要它，
   *  而"组装根是 main 进程唯一读环境的点"这条纪律要求环境只在 `createBootContext` 读一次。 */
  homeDir: string;
  /** 数据根：dev 态 `~/.my-harness-desktop-dev`，打包态 `~/.my-harness-desktop`。 */
  dataRoot: string;
  /** `<dataRoot>/config`。 */
  configDir: string;
  /** `<configDir>/general.json`（通用设置种子文件）。**列进路径表以保单源**：
   *  `40-shell-plugins` 步骤写它，`MainContext.paths.generalConfigPath` 读它，
   *  两处各自 `join` 一遍就会漂。 */
  generalConfigPath: string;
  /** 内置壳插件根：dev 态 `<repo>/src/plugins`，打包态 `resources/my-harness-desktop-builtin`。 */
  builtinPluginsDir: string;
  /** 用户壳插件根：`<dataRoot>/plugins`。 */
  userPluginsDir: string;
  /** 已安装（第三方）壳插件根：`<dataRoot>/installed`。 */
  installedPluginsDir: string;
  /** 项目级壳插件根：`<cwd>/.my-harness-desktop/plugins`。
   *  ⚠ 打包态 `cwd` 通常是家目录，于是它解析到与 `userPluginsDir` **同一个物理目录**，
   *  等效于同一根被扫两次（`registerAll` 的覆盖去重吸收重复）。`assemble.ts:200-201`
   *  称此为"降级为另一个用户级"，本设计不改这一行为。 */
  projectPluginsDir: string;
  /** 内核工厂产物根：dev 态 `<cwd>/out/main/server/kernel`，
   *  打包态 `resources/app.asar/out/main/server/kernel`。 */
  kernelBuildRoot: string;
  /** **启动步骤产物根**：dev 态 `<cwd>/out/main/boot/steps`，
   *  打包态 `resources/app.asar/out/main/boot/steps`。
   *  ⚠ 打包态这是本仓第一个在 asar 内 `readdirSync` 的地方（`createRequire` 读 asar 已被
   *  内核工厂加载证明，`readdirSync` 尚无先例）；若不可用，`buildBootPlan` 的空计划断言
   *  会把症状变成响亮失败而不是静默空启动（§3.2.1）。 */
  bootStepsRoot: string;
  /** 内置技能源：dev 态 `<repo>/.claude/skills`，打包态 `resources/my-harness-desktop-skills`。 */
  bundledSkillsSource: string;
  /** 内置贴纸源：dev 态 `<repo>/assets/stickers`，打包态 `resources/my-harness-desktop-stickers`。 */
  bundledStickersSource: string;
  /** 镜像目的地：`<dataRoot>/skills`（技能挂摘挂的是**镜像后**的目录，故 `65-kernel-skills`
   *  必须 requires `30-assets-mirror`）。 */
  bundledSkillsDir: string;
  /** 镜像目的地：`<dataRoot>/stickers/bundled`。 */
  bundledStickersDir: string;
}

// ============ 步骤间传数据的唯一通道 ============

/**
 * 步骤间传数据的**唯一通道**。真扫描意味着 step 文件之间不能互相 import
 * （它们各自是独立的 rollup 产物，运行时才被发现，§3.4.1），所以跨步骤传数据只有这一条路。
 *
 * **生命周期 = 冷启动期间，`runColdBoot` 返回后即弃。** 这条必须显式声明，因为它是暖重载
 * "改哪个对象"的答案：运行期需要可变的状态（内核注册表的投影面、访问器缓存）归
 * `MainContext` / `KernelRuntimeState`，不归 `BootContext`。
 *
 * **每字段赋值点唯一**（§6.1.2 有静态守卫扫描 `steps/` 对账）：一个字段只由一个步骤写，
 * 其余步骤只读。读某字段的步骤必须（在 `requires` 的传递闭包内）依赖写它的那个步骤。
 */
export interface BootContext {
  // ---- 只读输入（组装根构造时即有；组装根是 main 进程唯一读环境的点，§4.4.1）----
  readonly host: Host;
  readonly isPackaged: boolean;
  readonly rendererDir: string;
  readonly paths: BootPaths;
  readonly prefsStore: JsonPrefsStore<Prefs>;
  /** 服务端口（`MHD_PORT` 或 8420）。由 `createBootContext` 读环境变量——仍在组装根内，
   *  所以"组装根是唯一读环境的点"这条不破。`90-transport` 用它 listen。
   *  ⚠ 设计文档 §2.4.3 的字段清单里 `port` 在"只读输入"与"输出"两段各出现一次，
   *  同名重复声明在 TS 接口里是 Duplicate identifier；而 `listen(port, bind)` 用的就是
   *  这个配置端口，绑定端口即配置端口，输出那份是冗余的。故只保留只读这一份。 */
  readonly port: number;
  /** 远程访问配置（`90-transport` 的绑定策略与热重绑闭包用）。 */
  readonly remoteConfig: RemoteConfigStore;
  /** 本地 token + HMAC 校验（`90-transport` 用）。 */
  readonly auth: RemoteAuth;
  /** `MHD_ENABLE_KERNELS`（逗号分隔内核 id）解析出的强制启用集合。
   *  运行时强制启用被 manifest 声明为 `enabled: false` 的内核（测试/演示用）。
   *  **在 `createBootContext` 里读环境变量**，不让 `10-kernel-plugins` 步骤自己读 `process.env`
   *  ——环境只在组装根读一次（§4.4.1）。空集 = 不强制启用任何内核。 */
  readonly forceEnableKernels: ReadonlySet<string>;
  /** 网关（RPC 分发 + 广播）。**放只读输入段而不是由 `50-wiring` 写**：
   *  `createGateway(auth.createTokenVerifier())` 只依赖 `auth`，没有任何后置依赖；
   *  而 `10-kernel-plugins` 构造的内核插件上下文里 `broadcastRefresh` 回调就要用它
   *  （内核装/升/降级完成后广播刷新）。设计文档把 gateway 列在 `50-wiring` 的写入清单里，
   *  实现时发现那条会让步骤 10 拿不到引用——按"只依赖 auth 就在输入段构造"修正。
   *  `50-wiring` 做的是往它上面**注册 handler**，不是创建它。 */
  readonly gateway: Gateway;
  /** 内核插件回调的**延迟引用**（本设计唯一合法的延迟绑定）。由 `createBootContext` 创建、
   *  `50-wiring` 绑定、内核插件回调在运行期读取。存在理由是一个消不掉的循环依赖：
   *  装载内核插件（10）需要回调 → 回调需要 `SessionStore`（50）→ `SessionStore` 需要
   *  `surfaces`（20）→ `surfaces` 需要注册表（10）。详见 `./late-refs.ts` 的文件头。 */
  readonly lateRefs: KernelLateRefs;

  // ---- 逐步填充（前序步骤写、后续步骤读；每字段赋值点唯一）----
  /** `10-kernel-plugins` 写。 */
  kernelRegistry?: KernelRegistry;
  /** `10-kernel-plugins` 写：注册表的**活访问器**（§3.6.3）。
   *  为什么和注册表同一步创建、而不是等到 `50-wiring`：`20-kernel-surfaces` 要用它构造
   *  `ModelCatalog`（后者必须持 getter 才不 stale），而访问器的 memo 缓存**只能有一份**——
   *  若 surfaces 内部自建一份，`bump()` 只清得到 `kernelState` 那一份，另一份会一直返回
   *  由旧插件实例造出来的对象（重载看起来成功、实际半新半旧）。所以"注册表 + 它的活视图"
   *  在同一步诞生，之后所有消费者共用这一个。 */
  kernelAccessors?: KernelAccessors;
  /** `10-kernel-plugins` 写：内核插件的扫描 + 装载能力（暖重载复用；理由同 `kernelAccessors`）。 */
  kernelLoader?: KernelPluginLoader;
  /** `20-kernel-surfaces` 写。 */
  surfaces?: KernelSurfaces;
  /** `40-shell-plugins` 写。 */
  registry?: PluginRegistry;
  /** `40-shell-plugins` 写。 */
  configStore?: ConfigStore;
  /** `40-shell-plugins` 写。 */
  i18nResources?: I18nResource;
  /** `50-wiring` 写。 */
  sessionStore?: SessionStore;
  /** `50-wiring` 写。 */
  sessionBus?: SessionBus;
  /** `50-wiring` 写。 */
  restartCoordinator?: RestartCoordinatorImpl;
  /** `50-wiring` 写（§5.1.3 从 `controllers/plugins.ts` 上提到组装根）。 */
  lifecycleDeps?: PluginLifecycleDeps;
  /** `50-wiring` 写（内核侧操作的依赖，§3.3.1）。 */
  kernelBootDeps?: KernelBootDeps;
  /** `50-wiring` 写（运行期可变状态的持有者，§3.6.2）。 */
  kernelState?: KernelRuntimeState;
  /** `50-wiring` 写：创建**空 Set**。此后只经 `kernelBootDeps.extensionActiveIds` 这个引用
   *  mutate（`kernel-fit-extension` 操作往里 add），**不是对 ctx 字段赋值**，
   *  所以"每字段赋值点唯一"不需要例外（§4.1）。 */
  extensionActiveIds?: Set<string>;
  /** `50-wiring` 写（§4.4.3 的返回来源）。 */
  mainContext?: MainContext;

  // ---- 输出（`90-transport` 写；httpServer/wsHandle 供 §4.3.4 的收尾用）----
  httpServer?: Server;
  wsHandle?: WsServerHandle;
  /** listen 成功后写入的本地 token（`Assembled.localToken` 的来源）。 */
  localToken?: string;
}

// ============ 计划与运行期状态 ============

/** 扫描 + 校验 + 拓扑排序的产物。`steps` 已按执行序排好。 */
export interface BootPlan {
  steps: BootStep[];
}

/** 扫描到的一个步骤产物。保留文件名是为了让 §3.2.2 规则 3（`id` 等于产物文件名去 `.js`）
 *  可判定——设计文档第一版草稿的 `scanBootSteps` 直接 `push(mod.default)`、把文件名丢了，
 *  于是那条规则被声明了三次却无法实现。 */
export interface ScannedStep {
  /** 产物文件名（含 `.js`）。 */
  file: string;
  step: BootStep;
}

/**
 * 运行期可变状态的持有者。由 `50-wiring` 创建、挂到 `MainContext` 上，
 * **冷启动结束后继续存活**（与 `BootContext` 的生命周期相反）。
 * 暖重载 `reloadKernelPlugins` 改的是它，不是 `BootContext`（§3.6.2）。
 */
export interface KernelRuntimeState {
  readonly registry: KernelRegistry;
  /** 当前投影面。重载时整体替换（原子赋值），消费者经 getter 读、不持快照。 */
  surfaces: KernelSurfaces;
  /** 内核侧操作的依赖。挂在这里而不是只放 `BootContext`，因为暖重载也要用它跑
   *  `KERNEL_*_OPS`（§3.6.2 图 5）。它的 `surfaces` 是 getter，所以重载后自动指向新投影面。 */
  readonly bootDeps: KernelBootDeps;
  /** 注册表派生面的**活访问器**（§3.6.3）；重载替换 `surfaces` 后必须调一次 `bump()` 清缓存
   *  （不 bump 会拿到由旧插件实例造出来的对象——重载看起来成功、实际全在用旧实现）。
   *
   *  阶段一时这里是 `accessors?: unknown` 占位（注释写明"阶段三才加"，以免阶段一的实现被迫
   *  造假对象）。阶段三已落地 `liveKernelAccessors`（`boot/kernel-accessors.ts`），
   *  故改为**必填的真类型**：占位类型会让消费侧写出 `as` 断言，把类型安全换成一句注释。 */
  readonly accessors: KernelAccessors;
  /** 内核插件的**扫描 + 装载**能力（`boot/kernel-plugin-loading.ts`）。
   *  冷启动（step 10）与暖重载（`kernel-reload.ts`）共用同一份逻辑，避免两者漂移。
   *  必须存在本状态里而不是暖路径现场重建：`loadKernelPlugin` 需要 `KernelPluginContext`，
   *  而它由 `paths`/`prefsStore`/`lateRefs`/`isPackaged` 闭包捕获——这些都挂在 `BootContext` 上，
   *  而 `BootContext` **冷启动结束即弃**（§2.4.3）。 */
  readonly loader: KernelPluginLoader;
}

/** 内核插件实体（内核侧操作表的 `E`）。就是圆心契约的 `KernelPlugin`——
 *  内核侧不需要额外的包装类型，插件对象本身已经是"一个实体"。 */
export type KernelEntity = KernelPlugin;
