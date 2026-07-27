// usePluginContext —— 按 pluginId 绑定的 PluginContext(domain/context 的 renderer 形态)。
//
// 插件不直接拼 pluginId 参数调 window.pi(易写错、无权限语义),经此 hook 拿绑定后的
// 上下文:config/sessions/fs/git/dialog 都已按 pluginId 预绑定。
// permissions 强制在 main IPC 边界(未声明抛错),本层只是绑定便利 + 类型收口。
import type {
  PluginConfigApi,
  PluginContext,
} from "@pi-desktop/core";
import type {
  SessionsApi,
  FsReadApi,
  GitReadApi,
  DialogApi,
  SessionInfo,
  ImageInput,
} from "@pi-desktop/core";
import type { SessionEvent, SyncSnapshot } from "@pi-desktop/core";

/** 绑定 pluginId 的 renderer PluginContext。每个槽组件内调用一次即可(无状态,纯绑定)。 */
export function usePluginContext(pluginId: string): PluginContext {
  const config: PluginConfigApi = {
    get: <T,>(key: string) => window.pi.config.get<T>(pluginId, key),
    set: <T,>(key: string, value: T) => window.pi.config.set(pluginId, key, value),
    all: () => window.pi.config.all(pluginId),
  };

  const sessions: SessionsApi = {
    getSnapshot: () => window.pi.sessions.getSnapshot() as Promise<SyncSnapshot>,
    onEvent: (cb) => window.pi.sessions.onEvent((e) => cb(e as SessionEvent)),
    list: (cwd) => window.pi.sessions.list(cwd) as Promise<SessionInfo[]>,
    start: (cwd) => window.pi.sessions.start(cwd).then(() => undefined),
    newSession: () => window.pi.sessions.newSession(),
    switchSession: (sessionPath) => window.pi.sessions.switchSession(sessionPath),
    prompt: (text, images?: ImageInput[]) => window.pi.sessions.prompt(text, images),
    abort: () => window.pi.sessions.abort(),
  };

  const fs: FsReadApi = {
    listDir: (cwd) => window.pi.fs.listDir(pluginId, cwd),
  };

  const git: GitReadApi = {
    status: (cwd) => window.pi.git.status(pluginId, cwd),
    fileDiff: (cwd, path) => window.pi.git.fileDiff(pluginId, cwd, path),
    fileContent: (cwd, path) => window.pi.git.fileContent(pluginId, cwd, path),
  };

  const dialog: DialogApi = {
    openDirectory: () => window.pi.dialog.openDirectory(),
    openImages: () => window.pi.dialog.openImages(),
  };

  return { config, sessions, fs, git, dialog };
}
