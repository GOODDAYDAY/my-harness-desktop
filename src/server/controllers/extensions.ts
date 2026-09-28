// IPC:内核拓展管理(kernelExtensions.*,按 kernel 作用域)+ restart 协调(restart.*)。
// 中性契约:同一组 channel,按 kernel 参数分派到对应 KernelExtensionSource;加第三个内核
// 只加 bootstrap 组装,本文件不改。
import type { Gateway } from "../routing/gateway";
import { IPC } from "@my-harness-desktop/shared";
import { t } from "../application/i18n/translator";
import type { MainContext } from "../application/context/main-context";
import type { KernelId } from "@my-harness-desktop/shared";

export function registerExtensions(gateway: Gateway, ctx: MainContext): void {
  const { sessionStore, restartCoordinator } = ctx;

  /** 取某内核的拓展源；缺面抛**可行动**错误。
   *  ⚠ 这条义务是函数形状带来的（§3.6.3）：今天的 `Record<KernelId, X>` 是 total 的，
   *  裸调 `.list()` 安全；改成 `ctx.kernelExtensionSource(kernel)` 后返回 `X | undefined`，
   *  不管它就会退化成 `TypeError: Cannot read properties of undefined`——那不是可行动错误。
   *  错误消息要**点名内核与面名**，并给出下一步（内核可能未装载/已卸载 → 重载内核插件）。 */
  const manager = (kernel: KernelId) => {
    const m = ctx.kernelExtensionSource(kernel);
    // 同 kernel.ts：面向用户的错误走服务端 i18n 查表（r78）。
    if (!m) throw new Error(t("shell.kernelExtensionFaceMissing", { kernel }));
    return m;
  };

  // 能力面（r46）：UI 据此**显式降级**——minimal 的内核插件系统第一版未落地，
  // 装/卸都直接返回失败；此前 UI 无从得知，用户要填完来源点安装才在事后看到错误（§7.6 违规）。
  gateway.register(IPC.kernelExtensions.capabilities, (_e, kernel: KernelId) => manager(kernel).capabilities);
  gateway.register(IPC.kernelExtensions.list, (_e, kernel: KernelId) => manager(kernel).list());
  gateway.register(IPC.kernelExtensions.enable, (_e, kernel: KernelId, id: string) => manager(kernel).enable(id));
  gateway.register(IPC.kernelExtensions.disable, (_e, kernel: KernelId, id: string) => manager(kernel).disable(id));
  gateway.register(IPC.kernelExtensions.install, (_conn, kernel: KernelId, source: string) => {
    return manager(kernel).install(source, (line) => gateway.broadcast(IPC.kernelExtensions.installProgress, line));
  });
  gateway.register(IPC.kernelExtensions.uninstall, (_conn, kernel: KernelId, id: string) => {
    return manager(kernel).uninstall(id, (line) => gateway.broadcast(IPC.kernelExtensions.installProgress, line));
  });

  // ---- IPC: restart 协调(§6.4) ----
  gateway.register(IPC.restart.pendingSessions, () => {
    const keys = sessionStore.getRunningSessionKeys();
    return keys.map((k) => ({ sessionKey: k, state: restartCoordinator.getState(k) }));
  });
  gateway.register(IPC.restart.restart, (_e, sessionKey: string) => restartCoordinator.restart(sessionKey));
  gateway.register(IPC.restart.restartAllIdle, () => restartCoordinator.restartIdlePending());
}
