// 启动上下文与环境解析 —— 把散在 `assemble.ts` 三处的路径解析收成一处**纯函数**。
//
// 依据 docs/design/boot-surface.md §2.4.4 / §4.4.1。
//
// 两个导出，职责严格分开（§4.5 可测性判据）：
//   · `resolveBootPaths(env)`：**纯函数**，环境全部由参数注入（homeDir/cwd/resourcesPath），
//     不读 `process`/`os`。于是整张 dev/打包态路径对照表可裸单测，不需要 mock 任何外层。
//   · `createBootContext(...)`：**唯一读环境的地方**，把真实环境喂给上面的纯函数，
//     并构造只读输入段的三个对象（prefsStore/remoteConfig/auth）。
// 这条分界就是"组装根是 main 进程唯一读环境的点"（`assemble.ts:83` 的既有声明）在启动面上的落点。
import { join, resolve } from "node:path";
import type { Host } from "@my-harness-desktop/shared";
import { myHarnessDesktopDirOf } from "../../application/config/paths";
import { JsonPrefsStore } from "../../application/config/json-prefs";
import { RemoteConfigStore } from "../../remote/remote-config";
import { RemoteAuth } from "../../remote/auth";
import { createGateway } from "../../routing/gateway";
import { DEFAULT_PREFS, type Prefs } from "../../application/context/main-context";
import type { BootContext, BootPaths } from "./types";
import { createKernelLateRefs } from "./late-refs";

/** `resolveBootPaths` 的环境输入。**全部由调用方注入**，本模块不读 `process`/`os`。 */
export interface BootPathEnv {
  isPackaged: boolean;
  /** `homedir()`。 */
  homeDir: string;
  /** `process.cwd()`。dev 态 = 仓库根；打包态通常是家目录（见 `projectPluginsDir` 的说明）。 */
  cwd: string;
  /** `process.resourcesPath`（仅打包态有意义；dev 态传什么都不影响结果）。 */
  resourcesPath: string;
}

/** 缺省服务端口。`MHD_PORT` 可覆盖（部署参数不是业务内容，环境变量是合法配置面）。 */
export const DEFAULT_PORT = 8420;

/**
 * 解析启动所需的全部路径 —— **纯函数**，一张表对应设计文档 §2.4.4 的十行对照。
 *
 * 为什么值得单独成函数：今天这些解析散在 `assemble.ts` 的 L85-102（数据根/config/prefs）、
 * L145-157（内核产物根/内置插件根/用户插件根）、L190-203（技能与贴纸的源和目的地、
 * 项目级插件根、installed 根）三处，中间还夹着 200 行别的逻辑。抽出来之后：
 * ① dev/打包态的分流只有一份实现，可裸单测；② 新增一个路径不会再把 `assemble` 撑长；
 * ③ `bootStepsRoot` 这个新路径有了明确的归属，而不是又一行散落的 `join(...)`。
 */
export function resolveBootPaths(env: BootPathEnv): BootPaths {
  const { isPackaged, homeDir, cwd, resourcesPath } = env;
  const dataRoot = myHarnessDesktopDirOf(homeDir, isPackaged);
  const configDir = join(dataRoot, "config");
  return {
    homeDir,
    dataRoot,
    configDir,
    generalConfigPath: join(configDir, "general.json"),
    // dev: __dirname=out/main，插件在 <repo>/src/plugins；pkg: 随壳分发到 resources/。
    // 内置插件与第三方插件平等：同一个 discoverPlugins，无 if(builtin) 分支。
    builtinPluginsDir: isPackaged
      ? join(resourcesPath, "my-harness-desktop-builtin")
      : resolve(cwd, "src/plugins"),
    userPluginsDir: join(dataRoot, "plugins"),
    installedPluginsDir: join(dataRoot, "installed"),
    // ⚠ 打包态 cwd 通常是家目录，于是它解析到与 userPluginsDir **同一个物理目录**，
    // 等效于同一根被扫两次（registerAll 的覆盖去重吸收重复）。assemble.ts:200-201 称此为
    // "降级为另一个用户级"，留待"打开项目"功能接（演进）；本设计不改这一行为。
    projectPluginsDir: join(cwd, ".my-harness-desktop", "plugins"),
    // 内核工厂产物根：与 kernel-plugin-loader 的 resolveKernelFactoryPath 同一形状
    // （`<构建根>/<manifest.id>/plugin.js`）。
    kernelBuildRoot: isPackaged
      ? join(resourcesPath, "app.asar", "out", "main", "server", "kernel")
      : join(cwd, "out", "main", "server", "kernel"),
    // 启动步骤产物根（新增）。⚠ 打包态这是本仓第一个在 asar 内 readdirSync 的地方：
    // createRequire 读 asar 已被内核工厂加载证明，readdirSync 尚无先例。若不可用，
    // buildBootPlan 的空计划断言会把它变成响亮失败（scan.ts）。
    bootStepsRoot: isPackaged
      ? join(resourcesPath, "app.asar", "out", "main", "boot", "steps")
      : join(cwd, "out", "main", "boot", "steps"),
    // 内置技能：仓库顶级 .claude/skills 随壳分发，启动时镜像到数据根（强制覆盖，受管目录）。
    bundledSkillsSource: isPackaged
      ? join(resourcesPath, "my-harness-desktop-skills")
      : resolve(cwd, ".claude/skills"),
    bundledSkillsDir: join(dataRoot, "skills"),
    // 内置贴纸：纯 UI 内容，不进模型上下文，无 ensure* 开关。
    bundledStickersSource: isPackaged
      ? join(resourcesPath, "my-harness-desktop-stickers")
      : resolve(cwd, "assets/stickers"),
    bundledStickersDir: join(dataRoot, "stickers", "bundled"),
  };
}

/** `createBootContext` 的环境输入（`resolveBootPaths` 的输入 + 端口 + 强制启用内核）。 */
export interface BootEnv extends BootPathEnv {
  /** `process.env["MHD_PORT"]` 的原始值（解析规则见下）。 */
  portFromEnv?: string | undefined;
  /** `process.env["MHD_ENABLE_KERNELS"]` 的原始值（逗号分隔内核 id；缺省空）。 */
  enableKernelsFromEnv?: string | undefined;
}

/** 解析 `MHD_ENABLE_KERNELS`：逗号分隔 → 去空白 → 去空项 → 集合。纯函数，可裸单测。 */
export function parseForceEnableKernels(raw: string | undefined): ReadonlySet<string> {
  return new Set((raw ?? "").split(",").map((s) => s.trim()).filter(Boolean));
}

/**
 * 构造 `BootContext` 的**只读输入段**。其余字段由各步骤逐步填充（§2.4.3）。
 *
 * 端口解析规则与今天一致（`assemble.ts:91`）：`MHD_PORT` 是正数才用，否则 8420。
 * 这个"只在 >0 时才覆盖"的判据不是装饰——`MHD_PORT=abc` 或 `MHD_PORT=0` 都会落回默认，
 * 而不是绑到 NaN/0 端口（0 会让 OS 随机分配，于是 renderer 拿到的 URL 端口对不上）。
 */
export function createBootContext(
  host: Host,
  rendererDir: string,
  env: BootEnv,
): BootContext {
  const paths = resolveBootPaths(env);
  const fromEnv = Number(env.portFromEnv);
  const port = fromEnv > 0 ? fromEnv : DEFAULT_PORT;
  const prefsStore = new JsonPrefsStore<Prefs>(join(paths.configDir, "config.json"), DEFAULT_PREFS);
  const remoteConfig = new RemoteConfigStore(join(paths.configDir, "remote.json"));
  // 三者必须**同源**：gateway 的 token 校验器来自同一个 RemoteAuth 实例，
  // 否则它校验不了那个实例签发的 token（登录成功却连不上 WS）。
  const auth = new RemoteAuth(remoteConfig);
  const gateway = createGateway(auth.createTokenVerifier());
  return {
    host,
    isPackaged: env.isPackaged,
    rendererDir,
    paths,
    prefsStore,
    port,
    remoteConfig,
    auth,
    // gateway 只依赖 auth.createTokenVerifier()，故在此构造（见 BootContext.gateway 的说明）。
    gateway,
    forceEnableKernels: parseForceEnableKernels(env.enableKernelsFromEnv),
    // 延迟引用容器在此创建（未绑定），50-wiring 绑定——理由见 ./late-refs.ts 文件头。
    lateRefs: createKernelLateRefs(),
  };
}
