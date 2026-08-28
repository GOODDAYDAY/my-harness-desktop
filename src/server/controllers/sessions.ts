// IPC:会话域 —— session.*/sessions.* 全部 handler(SessionStore 单持的实现面)。
import type { Gateway } from "../routing/gateway";
import { sep } from "node:path";
import { expandDesktopPath } from "../application/config/paths";
import { IPC } from "@my-harness-desktop/shared";
import type { ImageInput, SessionRole, SessionModelPrefs } from "@my-harness-desktop/shared";
import type { DisplayMeta } from "@my-harness-desktop/shared";
import type { QuestionAnswer } from "@my-harness-desktop/shared";
import type { KernelId } from "@my-harness-desktop/shared";
import type { MainContext, MainPaths } from "../application/context/main-context";

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

export function registerSessions(gateway: Gateway, ctx: MainContext): void {
  const { sessionStore } = ctx;

  gateway.register(IPC.session.start, async (_e, cwd: string, sessionPath?: string, role?: SessionRole) => {
    await sessionStore.start(cwd, sessionPath, role);
    return { ok: true };
  });
  gateway.register(IPC.session.stop, async (_e, sessionPath?: string | null) => {
    await sessionStore.stop(sessionPath ?? null);
    return { ok: true };
  });
  gateway.register(IPC.session.setContext, (_e, cwd: string, sessionPath: string | null) => {
    // 只设上下文,不抢跑起内核进程(内核=模型的派生量):进程在「选模型 → 发送」时按需起,
    // 会话归属由用户选的模型决定。此前此处 warmup 抢跑双内核,会话被绑进预热时随机定的
    // 中立会话 + 首注册内核——选 dsh 却路由到 pi、幽灵会话、列表混乱的根因(§1.5 多内核默认)。
    sessionStore.setContext(cwd, sessionPath);
  });
  gateway.register(IPC.session.answerQuestion,
    (_e, requestId: string, answers: QuestionAnswer[]) =>
      sessionStore.answerQuestion(requestId, answers));
  gateway.register(IPC.session.listTools, () => sessionStore.listTools());
  gateway.register(IPC.session.getSnapshot, () => sessionStore.getSnapshot());
  gateway.register(IPC.session.sync, () => sessionStore.sync());
  gateway.register(IPC.session.switchKernel, (_e, target: KernelId) => sessionStore.switchKernel(target));
  gateway.register(IPC.session.getCapabilities, () => sessionStore.getCapabilities());
  gateway.register(IPC.session.open, (_e, sessionPath: string) => sessionStore.openSession(sessionPath));
  gateway.register(IPC.session.readToolConfig, (_e, sessionPath: string) => sessionStore.readToolConfig(sessionPath));
  gateway.register(IPC.session.copySession, async (_e, srcPath: string, targetPath: string) => {
    const src = expandDesktopPath(srcPath, ctx.paths.homeDir, ctx.paths.myHarnessDesktopDir);
    const target = expandDesktopPath(targetPath, ctx.paths.homeDir, ctx.paths.myHarnessDesktopDir);
    assertSessionPathAllowed(src, ctx.paths);
    assertSessionPathAllowed(target, ctx.paths);
    // 必须 await:此前 void 派发,复制失败(源缺失等)变 main 未捕获拒绝,
    // renderer 永远 resolve——调用方照写元数据,产出指向不存在副本的幽灵记录。
    await sessionStore.copySession(src, target);
    return { ok: true };
  });
  gateway.register(IPC.session.rename, async (_e, sessionPath: string, name: string) => {
    await sessionStore.renameSession(sessionPath, name);
    return { ok: true };
  });
  gateway.register(
    IPC.session.updateHeader,
    async (_e, sessionPath: string, patch: { name?: string; pinned?: boolean; archived?: boolean }) => {
      await sessionStore.updateHeader(sessionPath, patch);
      return { ok: true };
    },
  );
  gateway.register(IPC.session.delete, async (_e, paths: string[]) => {
    await sessionStore.deleteSessions(paths);
    return { ok: true };
  });
  gateway.register(IPC.session.prompt, (_e, text: string, images?: ImageInput[], display?: DisplayMeta, prefs?: SessionModelPrefs) =>
    sessionStore.prompt(text, images, display, prefs),
  );
  gateway.register(IPC.session.abort, () => sessionStore.abort());
  gateway.register(IPC.session.getModels, () => sessionStore.getModels());
  gateway.register(IPC.session.setModel, (_e, provider: string, modelId: string, kernel: KernelId) =>
    sessionStore.setModel(provider, modelId, kernel),
  );
  gateway.register(IPC.session.getThinkingLevels, () => sessionStore.getThinkingLevels());
  gateway.register(IPC.session.setThinkingLevel, (_e, level: string) =>
    sessionStore.setThinkingLevel(level),
  );
  gateway.register(IPC.session.getStats, () => sessionStore.getStats());
  gateway.register(IPC.sessions.list, (_e, cwd: string) => sessionStore.list(cwd));
  gateway.register(IPC.sessions.rawFilePaths, (_e, sessionId: string) => sessionStore.rawFilePaths(sessionId));
  gateway.register(IPC.sessions.projectStats, (_e, cwd: string) => sessionStore.projectStats(cwd));
  gateway.register(IPC.sessions.getTree, (_e, sessionId: string) => sessionStore.getTree(sessionId));
  gateway.register(IPC.sessions.bookmark, (_e, sessionPath: string, entryId: string, id: string, label: string, preview: string) => sessionStore.bookmark(sessionPath, entryId, id, label, preview));
  gateway.register(IPC.sessions.resume, (_e, snapshotId: string) => sessionStore.resume(snapshotId));
  gateway.register(IPC.sessions.deleteBookmark, (_e, snapshotId: string) => sessionStore.deleteBookmark(snapshotId));

  // ---- MessagingApi(消息发送变体)----
  gateway.register(IPC.session.steer, (_e, text: string, images?: ImageInput[]) => sessionStore.steer(text, images));
  gateway.register(IPC.session.followUp, (_e, text: string, images?: ImageInput[]) => sessionStore.followUp(text, images));
  gateway.register(IPC.session.abortRetry, () => sessionStore.abortRetry());
  gateway.register(IPC.session.continue, () => sessionStore.continue());

  // ---- ModelApi(模型快捷切换)----
  gateway.register(IPC.session.cycleModel, () => sessionStore.cycleModel());
  gateway.register(IPC.session.cycleThinkingLevel, () => sessionStore.cycleThinkingLevel());
  // 模型连通性测试:内核起独立临时会话进程 ping 一次,测完清理、不碰激活会话。
  // cwd 空(新装机未选目录)时兜底 homeDir——测试只需一个合法 spawn 工作目录,
  // 强制要求"先选项目"把新用户挡在第一步(实证:新装机点测试必报"未选择工作目录")。
  gateway.register(IPC.session.testModel, (_e, cwd: string, provider: string, modelId: string, kernel: KernelId) =>
    sessionStore.test(cwd || ctx.paths.homeDir, provider, modelId, kernel),
  );

  // ---- SessionTreeApi(会话树操作)----
  gateway.register(IPC.session.fork, (_e, parentLineageId: string, boundary?: string) => sessionStore.fork(parentLineageId, boundary));
  // forkFromSession 已切中立 lineage(§kernel-forkless §14):入参是源会话 neutralSessionId,
  // 不再是文件路径;不复制文件 → 无需路径圈禁(旧 gate 会误拒裸 UUID ns,打断 timeline 分叉)。
  gateway.register(IPC.session.forkFromSession, (_e, cwd: string, srcNs: string, entryId: string, position?: "before" | "at") =>
    sessionStore.forkFromSession(cwd, srcNs, entryId, position),
  );
  gateway.register(IPC.session.clone, () => sessionStore.clone());
  gateway.register(IPC.session.getForkMessages, (_e, entryId: string) => sessionStore.getForkMessages(entryId));

  // ---- SessionMaintenanceApi(会话维护)----
  gateway.register(IPC.session.compact, (_e, customInstructions?: string) => sessionStore.compact(customInstructions));
  gateway.register(IPC.session.setAutoCompaction, (_e, enabled: boolean) => sessionStore.setAutoCompaction(enabled));
  gateway.register(IPC.session.setAutoRetry, (_e, enabled: boolean) => sessionStore.setAutoRetry(enabled));
  gateway.register(IPC.session.exportHtml, async (_e, outputPath?: string) => {
    const result = await sessionStore.exportHtml(outputPath);
    return result;
  });
  gateway.register(IPC.session.getLastAssistantText, () => sessionStore.getLastAssistantText());

  // ---- QueueModeApi(队列模式)----
  gateway.register(IPC.session.setSteeringMode, (_e, mode: "all" | "one-at-a-time") => sessionStore.setSteeringMode(mode));
  gateway.register(IPC.session.setFollowUpMode, (_e, mode: "all" | "one-at-a-time") => sessionStore.setFollowUpMode(mode));

  // ---- BashApi(需声明 rpc:bash 权限,高危 RCE 门控)----
  gateway.register(IPC.session.runBash, (_e, command: string, excludeFromContext?: boolean) =>
    sessionStore.run(command, { excludeFromContext }),
  );
  gateway.register(IPC.session.abortBash, () => sessionStore.abortBash());
}
