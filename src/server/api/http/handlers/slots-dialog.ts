// 槽位清单(Core)+ 系统对话框/文件管理器(Host,web-service §20.3/§20.4)。
// Core 经 registry;Host 经 conn.host——local 连接 host = Electron,remote 降级 UNSUPPORTED。
import { join } from "node:path";
import { IPC } from "@my-harness-desktop/shared";
import type { Gateway } from "../../../application/remote/gateway";
import type { MainContext } from "../../ipc/main-context";

export function registerSlotsDialog(gateway: Gateway, ctx: MainContext): void {
  const { registry } = ctx;

  // ---- 槽位清单(Core,§16.2)----
  gateway.register(IPC.slots.sidePanel, () => registry.sidePanelItems());
  gateway.register(IPC.slots.sidebar, () => registry.sidebarItems());
  gateway.register(IPC.slots.mainView, () => registry.mainViewItems());
  gateway.register(IPC.slots.titlebar, () => registry.titlebarItems());
  gateway.register(IPC.slots.fileActions, () => registry.fileActionItems());
  gateway.register(IPC.slots.fileIcons, () => registry.fileIconItems());
  gateway.register(IPC.slots.messageActions, () => registry.messageActionItems());
  gateway.register(IPC.slots.blockRenderers, () => registry.blockRendererItems());
  gateway.register(IPC.slots.codeBlockRenderers, () => registry.codeBlockRendererItems());
  gateway.register(IPC.slots.sessionGroupings, () => registry.sessionGroupingItems());
  gateway.register(IPC.slots.composerPolicies, () => registry.composerPolicyItems());
  gateway.register(IPC.slots.composerAttachments, () => registry.composerAttachmentItems());
  gateway.register(IPC.slots.composerActions, () => registry.composerActionItems());
  gateway.register(IPC.slots.composerStats, () => registry.composerStatsItems());
  gateway.register(IPC.slots.settingsGroups, () => registry.settingsGroupItems());

  // ---- 对话框(Host,§20.3)----
  gateway.register(IPC.dialog.openDirectory, (conn) => conn.host.dialog.openDirectory());
  gateway.register(IPC.dialog.openImages, (conn) => conn.host.dialog.openImages());
  gateway.register(IPC.dialog.openTextFile, (conn, opts) => conn.host.dialog.openTextFile(opts));
  gateway.register(IPC.dialog.saveTextFile, (conn, opts) => conn.host.dialog.saveTextFile(opts));
  gateway.register(IPC.dialog.writeImages, (conn, dir, images) => conn.host.dialog.writeImages(dir, images));
  gateway.register(IPC.dialog.saveZip, (conn, opts) => conn.host.dialog.saveZip(opts));
  gateway.register(IPC.dialog.openZip, (conn, opts) => conn.host.dialog.openZip(opts));

  // ---- 系统文件管理器/外部资源(Host,§20.4)。~ 展开用 ctx.paths.homeDir(壳的路径注入)----
  const expand = (path: string): string => (path.startsWith("~/") ? join(ctx.paths.homeDir, path.slice(2)) : path);
  gateway.register(IPC.misc.openFile, (conn, path: string) => conn.host.shell.openPath(expand(path)));
  gateway.register(IPC.misc.revealPath, (conn, path: string) => conn.host.shell.revealPath(expand(path)));
}
