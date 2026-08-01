// IPC:会话域 —— session.*/sessions.* 全部 handler(SessionStore 单持的实现面)。
import { ipcMain } from "electron";
import { join } from "node:path";
import { IPC } from "../preload/ipc-channels";
import type { ImageInput } from "../../core/domain/sessions";
import type { MainContext } from "./main-context";

export function registerSessionsIpc(ctx: MainContext): void {
  const { sessionStore } = ctx;

  ipcMain.handle(IPC.session.start, async (_e, cwd: string, sessionPath?: string) => {
    await sessionStore.start(cwd, sessionPath);
    return { ok: true };
  });
  ipcMain.handle(IPC.session.stop, async (_e, sessionPath?: string | null) => {
    await sessionStore.stop(sessionPath ?? null);
    return { ok: true };
  });
  ipcMain.handle(IPC.session.setContext, (_e, cwd: string, sessionPath: string | null) => {
    sessionStore.setContext(cwd, sessionPath);
  });
  ipcMain.handle(IPC.session.replyExtensionUI,
    (_e, requestId: string, response: { value?: string; confirmed?: boolean; cancelled?: true }) =>
      sessionStore.replyExtensionUI(requestId, response));
  ipcMain.handle(IPC.session.getSnapshot, () => sessionStore.getSnapshot());
  ipcMain.handle(IPC.session.sync, () => sessionStore.sync());
  ipcMain.handle(IPC.session.open, (_e, sessionPath: string) => sessionStore.openSession(sessionPath));
  ipcMain.handle(IPC.session.readToolConfig, (_e, sessionPath: string) => sessionStore.readToolConfig(sessionPath));
  ipcMain.handle(IPC.session.copySession, (_e, srcPath: string, targetPath: string) => {
    const expandHome = (p: string): string =>
      p.startsWith("~/") ? join(ctx.paths.homeDir, p.slice(2)) : p;
    void sessionStore.copySession(expandHome(srcPath), expandHome(targetPath));
  });
  ipcMain.handle(IPC.session.rename, async (_e, sessionPath: string, name: string) => {
    await sessionStore.renameSession(sessionPath, name);
    return { ok: true };
  });
  ipcMain.handle(
    IPC.session.updateHeader,
    async (_e, sessionPath: string, patch: { name?: string; pinned?: boolean; archived?: boolean }) => {
      await sessionStore.updateHeader(sessionPath, patch);
      return { ok: true };
    },
  );
  ipcMain.handle(IPC.session.delete, async (_e, paths: string[]) => {
    await sessionStore.deleteSessions(paths);
    return { ok: true };
  });
  ipcMain.handle(IPC.session.prompt, (_e, text: string, images?: ImageInput[]) =>
    sessionStore.prompt(text, images),
  );
  ipcMain.handle(IPC.session.abort, () => sessionStore.abort());
  ipcMain.handle(IPC.session.getModels, () => sessionStore.getModels());
  ipcMain.handle(IPC.session.setModel, (_e, provider: string, modelId: string) =>
    sessionStore.setModel(provider, modelId),
  );
  ipcMain.handle(IPC.session.getThinkingLevels, () => sessionStore.getThinkingLevels());
  ipcMain.handle(IPC.session.setThinkingLevel, (_e, level: string) =>
    sessionStore.setThinkingLevel(level),
  );
  ipcMain.handle(IPC.session.getStats, () => sessionStore.getStats());
  ipcMain.handle(IPC.sessions.list, (_e, cwd: string) => sessionStore.list(cwd));
  ipcMain.handle(IPC.sessions.recentSettings, (_e, cwd: string) => sessionStore.recentSettings(cwd));
  ipcMain.handle(IPC.sessions.projectStats, (_e, cwd: string) => sessionStore.projectStats(cwd));

  // ---- MessagingApi(消息发送变体)----
  ipcMain.handle(IPC.session.steer, (_e, text: string, images?: ImageInput[]) => sessionStore.steer(text, images));
  ipcMain.handle(IPC.session.followUp, (_e, text: string, images?: ImageInput[]) => sessionStore.followUp(text, images));
  ipcMain.handle(IPC.session.abortRetry, () => sessionStore.abortRetry());

  // ---- ModelApi(模型快捷切换)----
  ipcMain.handle(IPC.session.cycleModel, () => sessionStore.cycleModel());
  ipcMain.handle(IPC.session.cycleThinkingLevel, () => sessionStore.cycleThinkingLevel());
  // 模型连通性测试:内核起独立临时会话进程 ping 一次,测完清理、不碰激活会话。
  ipcMain.handle(IPC.session.testModel, (_e, cwd: string, provider: string, modelId: string) =>
    sessionStore.test(cwd, provider, modelId),
  );

  // ---- SessionTreeApi(会话树操作)----
  ipcMain.handle(IPC.session.fork, (_e, entryId: string) => sessionStore.fork(entryId));
  ipcMain.handle(IPC.session.clone, () => sessionStore.clone());
  ipcMain.handle(IPC.session.getForkMessages, (_e, entryId: string) => sessionStore.getForkMessages(entryId));

  // ---- SessionMaintenanceApi(会话维护)----
  ipcMain.handle(IPC.session.compact, (_e, customInstructions?: string) => sessionStore.compact(customInstructions));
  ipcMain.handle(IPC.session.setAutoCompaction, (_e, enabled: boolean) => sessionStore.setAutoCompaction(enabled));
  ipcMain.handle(IPC.session.setAutoRetry, (_e, enabled: boolean) => sessionStore.setAutoRetry(enabled));
  ipcMain.handle(IPC.session.exportHtml, async (_e, outputPath?: string) => {
    const result = await sessionStore.exportHtml(outputPath);
    return result;
  });
  ipcMain.handle(IPC.session.getLastAssistantText, () => sessionStore.getLastAssistantText());

  // ---- QueueModeApi(队列模式)----
  ipcMain.handle(IPC.session.setSteeringMode, (_e, mode: "all" | "one-at-a-time") => sessionStore.setSteeringMode(mode));
  ipcMain.handle(IPC.session.setFollowUpMode, (_e, mode: "all" | "one-at-a-time") => sessionStore.setFollowUpMode(mode));

  // ---- BashApi(需声明 rpc:bash 权限,高危 RCE 门控)----
  ipcMain.handle(IPC.session.runBash, (_e, command: string, excludeFromContext?: boolean) =>
    sessionStore.run(command, { excludeFromContext }),
  );
  ipcMain.handle(IPC.session.abortBash, () => sessionStore.abortBash());
}
