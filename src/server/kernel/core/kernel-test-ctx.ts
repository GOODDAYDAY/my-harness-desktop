// 内核插件测试共享的「真实 ctx」构造器 —— 消除"啥都走 mock"的批评。
// prefs 用真实 JsonPrefsStore(临时 config.json 文件),状态标记/刷新计数真实累加,
// getCwd 返回真实临时目录。唯一合理 mock 是 KernelRuntime(npm/registry 是外层网络)。
// 用法:const { ctx, restarts, refreshes, prefsStore } = makeRealCtx(homedir, cwd);

import { JsonPrefsStore } from "../../application/config/json-prefs";
import { DEFAULT_PREFS, type Prefs } from "../../application/context/main-context";
import type { KernelPluginContext } from "@my-harness-desktop/shared";
import { join } from "node:path";

export interface RealCtx {
  ctx: KernelPluginContext;
  /** 真实的 markPending 记录(每次 markSessionsPendingRestart 追加)。 */
  restarts: string[];
  /** 真实的 refresh 计数(每次 broadcastRefresh +1)。 */
  refreshes: number;
  /** 真实的 prefs 文件 store。 */
  prefsStore: JsonPrefsStore<Prefs>;
}

export function makeRealCtx(homedir: string, cwd: string): RealCtx {
  const prefsStore = new JsonPrefsStore<Prefs>(join(homedir, "config.json"), DEFAULT_PREFS);
  const restarts: string[] = [];
  let refreshes = 0;
  const ctx: KernelPluginContext = {
    isPackaged: false,
    homedir,
    dataRoot: join(homedir, ".my-harness-desktop"),
    prefs: {
      get: <T>(key: string): T | undefined => prefsStore.get(key as keyof Prefs) as T | undefined,
      set: <T>(key: string, value: T): void => { prefsStore.set(key as keyof Prefs, value as Prefs[keyof Prefs]); },
    },
    testModel: (p, m) => Promise.resolve({ ok: false, error: `no real backend for ${p}/${m}` }),
    markSessionsPendingRestart: (reason) => { restarts.push(reason); },
    broadcastRefresh: () => { refreshes += 1; },
    builtinSkillsDir: join(homedir, "skills"),
    getCwd: () => cwd,
  };
  return { ctx, restarts, refreshes, prefsStore };
}
