// IPC:内核拓展管理(kernelExtensions.*,按 kernel 作用域)+ restart 协调(restart.*)。
// 中性契约:同一组 channel,按 kernel 参数分派到对应 KernelExtensionSource;加第三个内核
// 只加 bootstrap 组装,本文件不改。
import { BrowserWindow } from "electron";
import type { Gateway } from "../routing/gateway";
import { IPC } from "@my-harness-desktop/shared";
import type { MainContext } from "../application/context/main-context";
import type { KernelId } from "@my-harness-desktop/shared";

export function registerExtensions(gateway: Gateway, ctx: MainContext): void {
  const { kernelExtensions, sessionStore, restartCoordinator } = ctx;

  const manager = (kernel: KernelId) => {
    const m = kernelExtensions[kernel];
    if (!m) throw new Error(`未知内核: ${kernel}`);
    return m;
  };

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
