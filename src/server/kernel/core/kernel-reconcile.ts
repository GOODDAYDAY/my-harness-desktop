// 内核冷启动对账 —— 启动后异步扫描已装状态,缺失则按 dist-tag 最新版自动补装。
//
// 依据 docs/design/design-principles.md 的「反模式:内核安装靠用户手动触发」。内核是桌面自管的
// 资源,装不装不该由用户操心——启动后扫一遍,缺了自动补,装好即用。与 pi/dsh 的版本管理基类
// (KernelManager)并列:基类给「装/查」机制,本文件给「扫缺 → 判缺 → 补装」的编排。
//
// 可扩展点(用户要求「为后续写插件/改插件预留」):「扫描 → 判缺 → 补装/更新」三步是通用形状,
// 后续插件安装/更新扫描可复用同一形状(把 entry 从内核换成插件,manager 换成对应的扩展管理器)。
// 本函数只处理「缺失补装」;「有新版可更新」留演进(更新语义需产品决策,不在此静默升级)。
import type { KernelId } from "@my-harness-desktop/shared";
import type { KernelManager } from "./kernel-manager";

/** 一条待对账的内核:内核身份 + 其版本管理器实例。 */
export interface KernelReconcileEntry {
  kernel: KernelId;
  manager: KernelManager;
}

/** 对账结果状态:已装(跳过) / 已补装 / 失败。 */
export type KernelReconcileOutcome = "already" | "installed" | "failed";

/** 单条内核的对账结果。 */
export interface KernelReconcileResult {
  kernel: KernelId;
  outcome: KernelReconcileOutcome;
  error?: string;
}

/**
 * 冷启动内核对账:逐个扫已装状态,未装的按 dist-tag 最新版自动补装。
 * 串行执行(避免两个 npm install 并发抢 registry/锁);任一失败不抛,记入结果、继续下一个。
 *
 * @param entries 要扫描的内核列表(顺序即补装顺序)。
 * @param onProgress 补装进度回调(透传 npm install 的行输出;调用方决定进 UI 还是进日志)。
 * @param onSettled 每个内核settle后回调(already/installed/failed;调用方决定广播/刷新)。
 */
export async function reconcileMissingKernels(
  entries: readonly KernelReconcileEntry[],
  onProgress: (kernel: KernelId, line: string) => void,
  onSettled: (result: KernelReconcileResult) => void,
): Promise<void> {
  for (const { kernel, manager } of entries) {
    if (manager.currentVersion().available) {
      onSettled({ kernel, outcome: "already" });
      continue;
    }
    try {
      const { latest } = await manager.listVersions();
      if (!latest) {
        onSettled({ kernel, outcome: "failed", error: "registry 无 dist-tag 版本" });
        continue;
      }
      const result = await manager.install(latest, (line) => onProgress(kernel, line));
      onSettled({
        kernel,
        outcome: result.ok ? "installed" : "failed",
        error: result.error ?? undefined,
      });
    } catch (e) {
      onSettled({ kernel, outcome: "failed", error: e instanceof Error ? e.message : String(e) });
    }
  }
}
