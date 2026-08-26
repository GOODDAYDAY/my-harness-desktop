// IPC:会话域 —— session.*/sessions.* 全部 handler(SessionStore 单持的实现面)。
import { ipcMain } from "electron";
import { sep } from "node:path";
import { expandDesktopPath } from "../../client/paths";
import { IPC } from "../preload/ipc-channels";
import type { ImageInput, SessionRole, SessionModelPrefs } from "../../core/domain/sessions";
import type { DisplayMeta } from "../../core/domain/session-neutral";
import type { QuestionAnswer } from "../../core/domain/events/kernel-event";
import type { Anchor } from "../../core/domain/backend";
import type { KernelId } from "../../core/domain/kernel";
import type { MainContext, MainPaths } from "./main-context";

/** session 文件类通道(copySession/forkFromSession)的路径圈禁:逻辑前缀展开后只允许落在
 *  会话相关位置——pi 内核目录(~/.pi/agent)、桌面数据目录(~/.my-harness-desktop/,dev 态 -dev)、
 *  项目级数据目录(含 /.my-harness-desktop/ 段),越界抛错。
 *  不设防时 copySession 是裸文件复制原语:任意插件可把 ~/.ssh/id_rsa 复制进项目目录
 *  再经 fs:project 读回——声明能力的圈禁被核心默认能力绕过(根因:该通道无门控)。 */
function assertSessionPathAllowed(p: string, paths: MainPaths): void {
  const allowed =
    p.startsWith(paths.piAgentDir + sep) ||
    p.startsWith(paths.myHarnessDesktopDir + sep) ||
    p.includes(`${sep}.my-harness-desktop${sep}`);
  if (!allowed) throw new Error(`session 文件路径越界: ${p}`);
}

export function registerSessionsIpc(ctx: MainContext): void {
  const { sessionStore } = ctx;

  ipcMain.handle(IPC.session.start, async (_e, cwd: string, sessionPath?: string, role?: SessionRole) => {
    await sessionStore.start(cwd, sessionPath, role);
    return { ok: true };
  });
  ipcMain.handle(IPC.session.stop, async (_e, sessionPath?: string | null) => {
    await sessionStore.stop(sessionPath ?? null);
    return { ok: true };
  });
  ipcMain.handle(IPC.session.setContext, (_e, cwd: string, sessionPath: string | null) => {
    sessionStore.setContext(cwd, sessionPath);
    sessionStore.warmup(cwd, sessionPath);
  });
  ipcMain.handle(IPC.session.answerQuestion,
    (_e, requestId: string, answers: QuestionAnswer[]) =>
      sessionStore.answerQuestion(requestId, answers));
  ipcMain.handle(IPC.session.listTools, () => sessionStore.listTools());
  ipcMain.handle(IPC.session.getSnapshot, () => sessionStore.getSnapshot());
  ipcMain.handle(IPC.session.sync, () => sessionStore.sync());
  ipcMain.handle(IPC.session.switchKernel, (_e, target: KernelId) => sessionStore.switchKernel(target));
  ipcMain.handle(IPC.session.getCapabilities, () => sessionStore.getCapabilities());
  ipcMain.handle(IPC.session.open, (_e, sessionPath: string) => sessionStore.openSession(sessionPath));
  ipcMain.handle(IPC.session.readToolConfig, (_e, sessionPath: string) => sessionStore.readToolConfig(sessionPath));
  ipcMain.handle(IPC.session.copySession, async (_e, srcPath: string, targetPath: string) => {
    const src = expandDesktopPath(srcPath, ctx.paths.homeDir, ctx.paths.myHarnessDesktopDir);
    const target = expandDesktopPath(targetPath, ctx.paths.homeDir, ctx.paths.myHarnessDesktopDir);
    assertSessionPathAllowed(src, ctx.paths);
    assertSessionPathAllowed(target, ctx.paths);
    // 必须 await:此前 void 派发,复制失败(源缺失等)变 main 未捕获拒绝,
    // renderer 永远 resolve——调用方照写元数据,产出指向不存在副本的幽灵记录。
    await sessionStore.copySession(src, target);
    return { ok: true };
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
  ipcMain.handle(IPC.session.prompt, (_e, text: string, images?: ImageInput[], display?: DisplayMeta, prefs?: SessionModelPrefs) =>
    sessionStore.prompt(text, images, display, prefs),
  );
  ipcMain.handle(IPC.session.abort, () => sessionStore.abort());
  ipcMain.handle(IPC.session.getModels, () => sessionStore.getModels());
  ipcMain.handle(IPC.session.setModel, (_e, provider: string, modelId: string, kernel: KernelId) =>
    sessionStore.setModel(provider, modelId, kernel),
  );
  ipcMain.handle(IPC.session.getThinkingLevels, () => sessionStore.getThinkingLevels());
  ipcMain.handle(IPC.session.setThinkingLevel, (_e, level: string) =>
    sessionStore.setThinkingLevel(level),
  );
  ipcMain.handle(IPC.session.getStats, () => sessionStore.getStats());
  ipcMain.handle(IPC.sessions.list, (_e, cwd: string) => sessionStore.list(cwd));
  ipcMain.handle(IPC.sessions.projectStats, (_e, cwd: string) => sessionStore.projectStats(cwd));
  ipcMain.handle(IPC.sessions.getTree, (_e, sessionId: string) => sessionStore.getTree(sessionId));
  ipcMain.handle(IPC.sessions.bookmark, (_e, lineageId: string, boundary: string) => sessionStore.bookmark(lineageId, boundary));
  ipcMain.handle(IPC.sessions.resume, (_e, anchor: unknown) => sessionStore.resume(anchor as Anchor));
  ipcMain.handle(IPC.sessions.deleteBookmark, (_e, anchor: unknown) => sessionStore.deleteBookmark(anchor as Anchor));

  // ---- MessagingApi(消息发送变体)----
  ipcMain.handle(IPC.session.steer, (_e, text: string, images?: ImageInput[]) => sessionStore.steer(text, images));
  ipcMain.handle(IPC.session.followUp, (_e, text: string, images?: ImageInput[]) => sessionStore.followUp(text, images));
  ipcMain.handle(IPC.session.abortRetry, () => sessionStore.abortRetry());
  ipcMain.handle(IPC.session.continue, () => sessionStore.continue());

  // ---- ModelApi(模型快捷切换)----
  ipcMain.handle(IPC.session.cycleModel, () => sessionStore.cycleModel());
  ipcMain.handle(IPC.session.cycleThinkingLevel, () => sessionStore.cycleThinkingLevel());
  // 模型连通性测试:内核起独立临时会话进程 ping 一次,测完清理、不碰激活会话。
  // cwd 空(新装机未选目录)时兜底 homeDir——测试只需一个合法 spawn 工作目录,
  // 强制要求"先选项目"把新用户挡在第一步(实证:新装机点测试必报"未选择工作目录")。
  ipcMain.handle(IPC.session.testModel, (_e, cwd: string, provider: string, modelId: string, kernel: KernelId) =>
    sessionStore.test(cwd || ctx.paths.homeDir, provider, modelId, kernel),
  );

  // ---- SessionTreeApi(会话树操作)----
  ipcMain.handle(IPC.session.fork, (_e, parentLineageId: string, boundary?: string) => sessionStore.fork(parentLineageId, boundary));
  // forkFromSession 已切中立 lineage(§kernel-forkless §14):入参是源会话 neutralSessionId,
  // 不再是文件路径;不复制文件 → 无需路径圈禁(旧 gate 会误拒裸 UUID ns,打断 timeline 分叉)。
  ipcMain.handle(IPC.session.forkFromSession, (_e, cwd: string, srcNs: string, entryId: string, position?: "before" | "at") =>
    sessionStore.forkFromSession(cwd, srcNs, entryId, position),
  );
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
