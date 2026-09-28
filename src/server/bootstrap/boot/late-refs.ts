// 内核插件回调的**延迟引用** —— 本设计中唯一合法的延迟绑定，理由是一个消不掉的循环依赖。
//
// 循环长这样（依据 docs/design/boot-surface.md §4.1 的步骤划分与 §4.2.2 的依赖图）：
//
//   10-kernel-plugins  装载内核插件（工厂要拿到三个回调：markSessionsPendingRestart / getCwd / testModel）
//         ↓ 注册表
//   20-kernel-surfaces 投影出 surfaces（含 modelCatalog / sessionRoots / ids）
//         ↓ surfaces
//   50-wiring          构造 SessionStore（它的构造参数里就有 surfaces.modelCatalog 等）
//
// 而那三个回调要调用的正是 `SessionStore`。所以：**装载内核插件时需要一个还没被创建的对象的引用**。
// 调整步骤顺序消不掉它——SessionStore 依赖 surfaces，surfaces 依赖注册表，注册表来自装载内核插件。
//
// 今天的解法是 `let sessionStore!: SessionStore` + 闭包捕获（`assemble.ts:112-113`、`124-130`、`175`）：
// 声明时非空断言、赋值在 200 行之后，中间任何一处提前调用都是 `undefined` 上炸。步骤化之后
// 这个延迟引用收进本文件的窄接口，改善三点：
//   ① **单一填加点**：`bind()` 只能被 `50-wiring` 调一次，重复绑定抛错（两处填充会让语义不明）；
//   ② **未绑定即抛**，不是静默 no-op、也不是 `undefined` 上炸——错误消息直接说明"启动顺序错了"；
//   ③ **暴露行为不暴露对象**：内核插件回调只需要三件事，就给三个方法，不把 SessionStore 整个漏出去
//      （否则内核插件就能调到它不该调的面，耦合面凭空变大）。
//
// ⚠ 这不是"内存式/替身"实现：三个方法都**直接转发给真实的 SessionStore / RestartCoordinatorImpl**，
// 与今天闭包捕获的是同一批对象、同一条调用链，只是把"何时可用"这件事显式化了。
import type { KernelId, ModelTestResult } from "@my-harness-desktop/shared";
import type { SessionStore } from "../../application/sessions/session-store";
import type { RestartCoordinatorImpl } from "../../application/restart/restart-coordinator";

/** 内核插件回调所需的运行期依赖（由 `50-wiring` 一次性绑定）。 */
export interface KernelLateRefDeps {
  sessionStore: SessionStore;
  restartCoordinator: RestartCoordinatorImpl;
}

/** 延迟引用的对外面：只有内核插件工厂真正需要的三个行为。 */
export interface KernelLateRefs {
  /** 内核配置/扩展变更 → 把全部运行中会话标记为待重启。
   *  实现 = `restartCoordinator.markPendingAll(sessionStore.getRunningSessionKeys(), reason)`
   *  （与 `assemble.ts:124-127` 逐字一致）。 */
  markSessionsPendingRestart(reason: string): void;
  /** main 侧 cwd 事实源（`ConfigStore.getProjectDir` 与内核插件的 `getCwd` 都读它）。
   *
   *  ⚠ **本方法未绑定时返回 `null`，不抛**——与另外两个方法的语义刻意不同，理由是可验证的：
   *  `SessionStore.activeCwd` 初值就是 `null`（`session-store.ts:186`），要到 `setContext`/`start`
   *  才被赋值（`:423`/`:475`），而那两个都由 renderer 连上之后触发。所以**冷启动期间
   *  `getActiveCwd()` 本来就返回 `null`**，`ConfigStore.getProjectDir()` 随之返回 `null`
   *  （项目级配置层不参与合并）。"尚无活跃项目"在启动期是**事实**，不是错误——
   *  返回 null 与今天逐字等价；抛错反而会把一个合法状态变成启动失败。
   *
   *  这条区分让 `40-shell-plugins` 能在 `50-wiring` 之前构造 `ConfigStore`：
   *  设计文档 §4.2.3 曾断言"ConfigStore 只依赖路径、不依赖 surfaces"，**那句话不准确**——
   *  它的 `getProjectDir` 回调依赖 SessionStore，且 `configStore.get()` 会真的调用它
   *  （`config-store.ts:60→67→136`）。本方法是那个断言的修正落点。 */
  getActiveCwd(): string | null;
  /** 模型连通性测试：起独立临时会话进程发一条 ping（`KernelVersionApi` 的 test 面用）。
   *  `kernel` 由调用方（内核插件工厂）按自己的 id 传入。 */
  testModel(cwd: string, provider: string, modelId: string, kernel: KernelId): Promise<ModelTestResult>;
  /** 由 `50-wiring` 调用**恰好一次**。重复调用抛错。 */
  bind(deps: KernelLateRefDeps): void;
  /** 是否已绑定（诊断/测试用；生产代码不该据此分支——未绑定时调用会抛，那才是契约）。 */
  readonly bound: boolean;
}

/** 造一个未绑定的延迟引用容器。由 `createBootContext` 创建，故从冷启动第一刻就存在。 */
export function createKernelLateRefs(): KernelLateRefs {
  let deps: KernelLateRefDeps | null = null;
  const require_ = (): KernelLateRefDeps => {
    if (!deps) {
      throw new Error(
        "内核插件回调在 50-wiring 绑定之前被调用了（启动顺序错误：内核插件回调只能在冷启动完成后的运行期触发）",
      );
    }
    return deps;
  };
  return {
    markSessionsPendingRestart(reason) {
      const d = require_();
      d.restartCoordinator.markPendingAll(d.sessionStore.getRunningSessionKeys(), reason);
    },
    getActiveCwd() {
      // 未绑定 = 冷启动尚未接线 = 没有活跃 cwd（与 SessionStore.activeCwd 的初值同义），返回 null。
      return deps ? deps.sessionStore.getActiveCwd() : null;
    },
    testModel(cwd, provider, modelId, kernel) {
      return require_().sessionStore.test(cwd, provider, modelId, kernel);
    },
    bind(next) {
      if (deps) throw new Error("KernelLateRefs 已被绑定过（只允许 50-wiring 绑定一次）");
      deps = next;
    },
    get bound() {
      return deps !== null;
    },
  };
}
