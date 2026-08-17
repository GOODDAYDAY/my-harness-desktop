// 会话存储 —— application 层:多会话多 pi 进程调度。
//
// 进程模型(用户拍板):会话是文件,进程是按需的临时工,且**每会话一进程、多会话多进程**。
// - 看会话 = 读文件(session-scanner.readSession),不启 pi
// - 发消息 = 按需起该会话的 pi:ensureForSend 保证激活会话的 pi 在跑,
//   不杀其他会话的进程(多会话并存)
// - 切会话:setContext 设激活;激活会话 pi 活着则 resync 推基线,没活则等 prompt 时起
// - pi 启动/关闭不阻塞展示:进程动作全在发送路径上
//
// 依赖倒置:本层不 new RpcAdapter(那是 gateway 具体类),而是持 RpcAdapterFactory
// 接口(本层拥有),实现由 shell 注入。换运行时只换 factory 实现,本文件一行不改。
// application 依赖 gateway(type)+ domain,不依赖 shell。
import { existsSync, statSync } from "node:fs";
import type { RpcAdapter } from "../../../client/pi/rpc-adapter";
import { PiBackend } from "./pi-backend";
import { resync } from "../orchestrations/resync";
import type { BaseBackend, LineageTree, Anchor } from "../../domain/backend";
import { toModelInfo, toSessionStats } from "../../protocol/context-binding";
import type { RpcResponse, Model } from "../../protocol/rpc-types";
import type { SessionEvent, SyncSnapshot, ModelInfo, SessionStats, ProjectStats, NeutralMessage, TurnUsage } from "../../domain/events/session-state";
import { isVisibleMessage, deduplicateAdjacent, messageUsageOf, resolveContextUsage } from "../../domain/events/session-state";
import type { KernelEvent } from "../../domain/events/kernel-event";
import type { SessionStoreForRestart } from "../../domain/restart";
import type {
  SessionsApi, MessagingApi, ModelApi, SessionTreeApi, SessionMaintenanceApi, QueueModeApi, BashApi,
  ImageInput, BashResult, SessionInfo, HeaderPatch, SessionDetail, SessionToolConfig, ModelTestResult,
  SessionModelPrefs, SessionRole,
} from "../../domain/sessions";
import { truncateSessionName, cwdToBucketName, messageContentText, SESSION_MODEL_PREFS_KEY, parseSessionModelPrefs, roleToPrompt } from "../../domain/sessions";
import {
  updateSessionHeader, listSessions, readSession, readSessionToolConfig, readSessionCustom,
  renameSession as renameSessionFile, copySession as copySessionFile,
  deleteSessionFiles,
} from "./session-scanner";
import { getProjectStats } from "./project-stats";
import { readContextProbeTokens } from "./context-probe";
import { ModelsStore } from "../models/models-store";
import { randomUUID } from "node:crypto";

/**
 * BaseBackendFactory —— application 拥有的依赖倒置抽象。
 * shell 实现并注入:create({cwd,agentDir,...}) 返回一个已实现 BaseBackend 的后端(pi 或 dsh),
 * 调用方再 .start()。本接口不暴露 spawn 细节(application 不感知子进程)。
 */
export interface BaseBackendFactory {
  create(opts: { cwd: string; agentDir: string; args?: string[]; env?: Record<string, string>; cliPath?: string }): BaseBackend;
}

function zeroTurnUsage(): TurnUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

/** 底座进程 spawn 时读取的配置文件清单(底座标准契约;session-store 管底座进程,职责内知识)。
 *  models-store.json 是底座自维护运行时缓存,桌面端不产生,不纳入。 */
const CONFIG_DEP_FILENAMES = ["models.json", "settings.json"] as const;

/** abort 命令超时(ms):agent.abort 会等 waitForIdle,工具未响应 agent signal 中断时阻塞。
 *  正常中止 1-2 秒返回,慢收尾留 8 秒余量;超时视为中断失败,由 abort() 强杀进程兜底。 */
const ABORT_TIMEOUT_MS = 8_000;

/** 配置文件依赖快照项:path + mtimeMs。文件不存在记 -1(存在性变化同样视为配置变更)。 */
interface ConfigSnapshotEntry {
  path: string;
  mtimeMs: number;
}

interface SessionProc {
  backend: BaseBackend;
  cwd: string;
  /** procs 当前 map key(初始 = sessionPath 或 new:${cwd})。fork/clone 对账经 rekeyProc
   *  迁到新会话文件路径,恒等于 boundSessionPath("key === 绑定路径"不变量);
   *  事件闭包按 proc.key 路由,迁移不丢转发。 */
  key: string;
  boundSessionPath: string | null;
  genStartMs: number | null;
  lastTps: number | null;
  /** 本轮输出 token 与生成时长(秒)的累计:agentStart 清零、messageEnd 累加,
   *  lastTps = roundOut/roundGenSec 即本轮加权速率——一轮多条 assistant 消息(工具循环)
   *  时不再定格在最后一条(往往最短)的瞬时速率。 */
  roundOut: number;
  roundGenSec: number;
  /** 本轮用量累计:agentStart 归档到 lastTurn 并清零,messageEnd 按 messageUsageOf 累加。
   *  翻轮只在 agentStart(agentEnd/agentSettled 同帧双发,先到者清零后到者再覆盖会恒 0)。 */
  turn: TurnUsage;
  /** 上一次完成轮用量;null=本进程内尚无完成轮。 */
  lastTurn: TurnUsage | null;
  /** 底座上下文锚点可信度:最后一条带 usage 的 assistant 消息是否真测到 prompt
   *  (input+cacheRead+cacheWrite>0)。false 时 getStats 用 context-probe 实测兜底。 */
  lastPromptAnchorReal: boolean;
  touched: boolean;
  /** 双写时文件未落盘(底座懒建)而降级的模型偏好——该进程首个 messageStart
   *  (文件必已落盘)补写清账(docs/design/session-model-config.md §4.5)。 */
  pendingModelPrefs?: SessionModelPrefs;
  /** 配置依赖快照(spawn 时记录):models.json/settings.json 的 mtime。复用前校验,
   *  任一变化 → 进程过期重建(docs/design/models-config-reload.md)。 */
  configSnapshot: ConfigSnapshotEntry[];
}

export class SessionStore implements
  SessionsApi, MessagingApi, ModelApi, SessionTreeApi, SessionMaintenanceApi, QueueModeApi, BashApi, SessionStoreForRestart
{
  /** 会话 → 进程条目。key = sessionPath(历史会话)或 `new:${cwd}`(新会话,未落盘)。 */
  private procs = new Map<string, SessionProc>();
  private warmups = new Map<string, Promise<void>>();
  /** session busy 状态:agentStart/autoRetryStart 设 true、agentSettled/autoRetryEnd(success=false) 设 false(§6.6)。 */
  private busyStates = new Map<string, boolean>();
  private factory: BaseBackendFactory;
  /** 视图流监听器(onEvent):只收激活会话的事件,渲染层不需关心多进程归属。 */
  private listeners = new Set<(event: SessionEvent) => void>();
  /** 运维流监听器:收全部会话的事件并带 sessionKey(restart-coordinator 等按 key 订阅)。 */
  private keyedListeners = new Set<(event: SessionEvent, sessionKey: string) => void>();
  /** Session Bus 上行帧监听器($bus 帧 + 来源 key;路由器在 bootstrap 订阅)。 */
  private busFrameListeners = new Set<(frame: Record<string, unknown>, sessionKey: string) => void>();
  private kernelListeners = new Set<(event: KernelEvent) => void>();
  private extUiListeners = new Set<(req: { requestId: string; method: string; [k: string]: unknown }) => void>();
  private snapshotListeners = new Set<(snapshot: SyncSnapshot) => void>();
  /** 最近一次 sync 的投影基线(renderer 增量应用的起点)。 */
  latestSnapshot: SyncSnapshot | null = null;

  /** 当前激活会话的 key(setContext 设);发送路径的目标。 */
  private activeCwd: string | null = null;
  private activeSessionPath: string | null = null;
  /** 激活会话在 procs 里的 key(初始 = sessionPath 或 new:${cwd})。fork/clone 对账时
   *  随 rekeyProc 迁到新会话文件路径(事件闭包按 proc.key 路由,迁移不丢转发)。 */
  private activeProcKey: string = "";

  /** factory 由 shell 在启动期注入(依赖倒置);不在此 new gateway 具体类。 */
  /** agentDir 由 shell 注入(pi 底座会话根目录);application 不直读 process.env.HOME(依赖倒置)。 */
  private agentDir: string;
  /** 系统 prompt 文件路径列表,spawn 时拉取(由 registry.systemPromptPaths() 注入,
   *  插件贡献的 systemPrompts 槽项;插件卸载 → 贡献移除 → 不注入);空数组不拼 argv。 */
  private getSystemPromptPaths: () => string[];
  /** 自定义底座 cli.js 路径 getter(docs/design/custom-cli-path.md §2.4):
   *  每次 createProc 现读 → 指针变更新进程天然生效;不缓存、不订阅、不感知变更事件。 */
  private getCustomCliPath: () => string | undefined;
  /** 模型配置读取(models.json):openSession 把文件基线的模型证据解析成 contextWindow。
   *  同 agentDir 注入模式(路径由 bootstrap 给),每次现读不缓存——配置改动天然生效。 */
  private modelsStore: ModelsStore;
  constructor(
    factory: BaseBackendFactory,
    agentDir: string,
    getSystemPromptPaths?: () => string[],
    getCustomCliPath?: () => string | undefined,
  ) {
    this.factory = factory;
    this.agentDir = agentDir;
    this.getSystemPromptPaths = getSystemPromptPaths ?? (() => []);
    this.getCustomCliPath = getCustomCliPath ?? (() => undefined);
    this.modelsStore = new ModelsStore({ agentDir });
  }

  /** 某会话 pi 是否活着。 */
  private isAlive(key: string): boolean {
    return this.procs.get(key)?.backend.alive ?? false;
  }

  get alive(): boolean {
    return this.activeProcKey ? this.isAlive(this.activeProcKey) : false;
  }

  /** 激活会话的 key(= activeProcKey)。 */
  private get activeKey(): string {
    return this.activeProcKey;
  }

  /** 激活会话的 backend(没起抛错;调用方先 ensure)。 */
  private activeProc(): SessionProc | undefined {
    return this.procs.get(this.activeKey);
  }

  /** path → proc key 寻址(根因修复,勿回退):fork/clone 对账经 rekeyProc 把条目迁到
   *  新文件路径(key === boundSessionPath),正常态按路径直接命中;兜底扫描 bound 防
   *  迁移时序差。找不到返回路径本身(作为新进程的待用 key)。历史教训:key 不迁移时,
   *  重开 fork 源会话会经 procs.get(源路径) 撞上已迁走的进程——误判存活、sync 推错
   *  会话基线、warmup 不再为源会话起真进程,retry 拿源会话 entryId 去 fork 迁移进程,
   *  底座报 "Invalid entry ID for forking"。 */
  private resolveProcKey(sessionPath: string): string {
    for (const [key, proc] of this.procs) {
      if (proc.boundSessionPath === sessionPath) return key;
    }
    return sessionPath;
  }

  /** 记录发送路径的上下文(cwd + 会话文件,null=新会话)。不动进程,只设激活。
   *  若激活会话 pi 活着 → resync 推基线(切回正在跑的会话拿实时状态);
   *  没活 → 清基线(renderer 走文件读或等 prompt 时起)。 */
  setContext(cwd: string, sessionPath: string | null): void {
    // 回收"未发送过消息的新会话壳"(根因修复,勿回退):
    // pref flush(setModel/setThinkingLevel 走 ensureForSend)会为本 cwd 起一个新会话进程,
    // pi 懒建会话文件——未 prompt 前 boundSessionPath 指向的文件尚不存在,进程是空壳。
    // 此前此处的回收分支查 `new:${cwd}` key,而 ensureForSend 把进程存在生成的会话路径
    // key 下(从不存 new:cwd),分支永不命中 → 每次新对话首发泄漏一个孤儿 pi(实测:一次
    // 发送起两个进程, pref flush 那个永不回收)。改为按重置前的激活 proc 判定:未发送过
    // 消息(touched=false)且活着 → stop+delete;有内容的会话进程不动(多会话并存)。
    const prevKey = this.activeProcKey;
    this.activeCwd = cwd;
    this.activeSessionPath = sessionPath;
    // 路径→key 经 resolveProcKey(fork/clone 对账已 rekey,正常态 key === 路径)
    const key = sessionPath ? this.resolveProcKey(sessionPath) : (cwd ? `new:${cwd}` : "");
    this.activeProcKey = key;
    if (prevKey && prevKey !== key) {
      const prevProc = this.procs.get(prevKey);
      if (prevProc && prevProc.backend.alive && !prevProc.touched) {
        void prevProc.backend.stop().then(() => { this.procs.delete(prevKey); });
      }
    }
    if (this.isAlive(key)) {
      // 激活会话 pi 活着:resync 推基线(切回流式中的会话拿实时状态)
      void this.sync().catch(() => {});
    } else {
      // 没活:清基线,renderer 走文件读
      this.latestSnapshot = null;
    }
    // 激活即推给 renderer 水合 useUiStore.currentSessionPath(根因修复,勿回退):
    // 底座 session_start 是纯扩展事件(_sessionStartEvent 只经 _extensionRunner.emit
    // 走扩展通道;AgentSessionEvent 联合不含 sessionStart;RPC stdout 永不见
    // session_start),renderer 永远等不到底座推出该事件。此前打开历史会话靠
    // sessions-list 手动补写 currentSessionPath——隐式契约,第二个忘记补写的入口
    // 就会导致"视图里有会话内容、发送却走了新会话分支"。修复:main 激活会话时
    // 主动推 synthetic sessionStart,当前会话流的真相源单一在 main。
    if (sessionPath) {
      this.dispatch(key, { type: "sessionStart", sessionFile: sessionPath });
    }
  }

  warmup(cwd: string, sessionPath: string | null): void {
    const key = sessionPath ? this.resolveProcKey(sessionPath) : (cwd ? `new:${cwd}` : "");
    if (!key || this.isAlive(key) || this.warmups.has(key)) return;
    let warmPath = sessionPath;
    if (!warmPath) {
      warmPath = this.generateNewSessionPath(cwd);
      this.activeSessionPath = warmPath;
      this.dispatch(key, { type: "sessionStart", sessionFile: warmPath });
    }
    const warmKey = this.resolveProcKey(warmPath);
    if (this.isAlive(warmKey) || this.warmups.has(warmKey)) return;
    const p = this.start(cwd, warmPath);
    this.warmups.set(warmKey, p);
    p.then(
      () => { this.warmups.delete(warmKey); },
      () => { this.warmups.delete(warmKey); },
    );
  }

  /** fs:project IPC 圈禁的锚点(当前激活项目根;shell 的 IPC 边界从这里取)。 */
  getActiveCwd(): string | null {
    return this.activeCwd;
  }

  /** 启动激活会话的 pi(按需;sessionPath 给定时 spawn --session 续上下文)。
   *  不杀其他会话的进程(多会话并存)。完成后 sync 广播基线。
   *  role:会话级角色卡,内联作 --append-system-prompt 的值注入系统上下文——
   *  "拉起 pi + 设系统上下文"两步合一,主会话与子会话同一条路径。 */
  async start(cwd: string, sessionPath?: string, role?: SessionRole): Promise<void> {
    this.activeCwd = cwd;
    this.activeSessionPath = sessionPath ?? null;
    // 路径→key 经 resolveProcKey(fork/clone 对账已 rekey,正常态 key === 路径)
    const key = sessionPath ? this.resolveProcKey(sessionPath) : `new:${cwd}`;
    this.activeProcKey = key;
    if (this.isAlive(key)) return; // 已活,不重复起
    const proc = this.createProc(key, cwd, sessionPath ?? null, [], role);
    this.procs.set(key, proc);
    await proc.backend.start();
    await this.waitReady(this.asPi(proc));
    // 并发护栏(根因修复,勿回退):start 的 await 窗口(spawn+waitReady,tsx dev pi 1~2s)
    // 内可能插入并发 setContext(⌘N/切目录/第二次 sendText 的 startNewChat)把
    // activeProcKey 切走。此后 sync 用 activeProc() 回查会落空抛误导性的"pi 未启动"。
    // 上下文已切则跳过视图同步(进程保留给多会话并存),由调用方(ensureForSend)校验激活态。
    if (this.activeProcKey !== key) return;
    await this.sync();
  }

  /** 创建并装配一个 pi 进程条目:backend + 全套事件绑定。
   *  start/restart 唯一装配入口——此前 restart 另抄一份丢了 onExtensionUI/onProcessExit,
   *  重启后的会话收不到扩展 UI 请求、进程退出静默(根因:同一逻辑两处拷贝)。
   *  extraArgs:调用方追加的 CLI 参数(目前唯一消费者是 test() 传 --no-session);
   *  正常会话不传,行为零变化。 */
  private createProc(key: string, cwd: string, sessionPath: string | null, extraArgs: readonly string[] = [], role?: SessionRole): SessionProc {
    const args = sessionPath ? ["--session", sessionPath] : [];
    for (const p of this.getSystemPromptPaths()) args.push("--append-system-prompt", p);
    // 会话级角色卡:role 文本内联作 --append-system-prompt 的值——
    // 底座 resolvePromptInput 对非文件路径参数当作文本本身,无需落文件。
    // 全局 systemPrompts 之上叠"这个会话是谁"(主会话与子会话平等)。
    if (role) args.push("--append-system-prompt", roleToPrompt(role));
    args.push(...extraArgs);
    const backend = this.factory.create({ cwd, agentDir: this.agentDir, args, cliPath: this.getCustomCliPath() });
    const proc: SessionProc = { backend, cwd, key, boundSessionPath: sessionPath, genStartMs: null, lastTps: null, roundOut: 0, roundGenSec: 0, turn: zeroTurnUsage(), lastTurn: null, lastPromptAnchorReal: false, touched: false, configSnapshot: this.captureConfigSnapshot() };
    // 闭包按 proc.key 路由(不捕获创建期 key):fork/clone 对账 rekeyProc 迁移条目后,
    // 事件仍按当前 key 进 dispatch,归属不漂。
    backend.onEvent((event) => this.dispatch(proc.key, event));
    // pi 专属通道($bus 帧 / Extension UI / 进程退出)经类型守卫,非 pi 后端不接这些线。
    const pi = this.asPi(proc);
    pi.onBusFrame((frame) => {
      for (const cb of this.busFrameListeners) {
        try {
          cb(frame, proc.key);
        } catch (err) { console.error("[session-store] bus 帧监听器抛错已隔离:", err); }
      }
    });
    pi.onExtensionUI((req) => {
      this.dispatchKernel({
        source: "pi", kind: "extensionUI",
        requestId: req.id, method: req.method, sessionKey: proc.key,
        // 其余底座协议字段透传(显式映射 id→requestId,不散播 req 以免 method 重复覆盖)
        payload: req,
      });
      for (const cb of this.extUiListeners) {
        try {
          // 映射底座协议(id)→ 中性契约(requestId),listener 见到的是 SessionsApi.onExtensionUI 契约形状
          cb({ requestId: req.id, method: req.method, sessionKey: proc.key, payload: req });
        } catch (err) { console.error("[session-store] Extension UI 监听器抛错已隔离:", err); }
      }
    });
    pi.onProcessExit = (exit, expected) => {
      this.dispatchKernel({
        source: "desktop", kind: "processExit",
        code: exit.code, signal: exit.signal, expected,
        stderr: pi.stderr.slice(-500), sessionKey: proc.key,
      });
    };
    return proc;
  }

  /** fork/clone 对账:进程条目从旧 key 迁到新会话文件路径,恢复"key === boundSessionPath"
   *  不变量(根因修复,勿回退为 key 不动):key 留在 fork 源路径时,重开源会话的
   *  setContext/warmup/start 会经 procs.get(源路径) 撞上已迁走的进程——误判"源会话
   *  活着"、sync 推出错会话基线、源会话永不起真进程;视图拿着源会话 entryId 去 fork
   *  迁移进程,底座报 "Invalid entry ID for forking"。迁移含 busyStates 账与激活 key。 */
  private rekeyProc(proc: SessionProc, newPath: string): void {
    const oldKey = proc.key;
    proc.boundSessionPath = newPath;
    if (oldKey === newPath) return;
    this.procs.delete(oldKey);
    this.procs.set(newPath, proc);
    proc.key = newPath;
    const busy = this.busyStates.get(oldKey);
    if (busy !== undefined) {
      this.busyStates.set(newPath, busy);
      this.busyStates.delete(oldKey);
    }
    if (this.activeProcKey === oldKey) this.activeProcKey = newPath;
  }

  /** 捕获底座进程的配置依赖快照:models.json/settings.json 的 mtime。
   *  文件不存在记 -1(存在性变化同样视为配置变更)。 */
  private captureConfigSnapshot(): ConfigSnapshotEntry[] {
    return CONFIG_DEP_FILENAMES.map((name) => {
      const p = `${this.agentDir}/${name}`;
      try {
        return { path: p, mtimeMs: statSync(p).mtimeMs };
      } catch {
        return { path: p, mtimeMs: -1 };
      }
    });
  }

  /** 配置依赖是否过期:重读快照逐项对比,任一 mtime 变化 → 进程需重建
   *  (底座模型快照 spawn 时定型,运行中不重读;复用旧进程 set_model 必失败)。 */
  private isConfigStale(proc: SessionProc): boolean {
    const now = this.captureConfigSnapshot();
    if (proc.configSnapshot.length !== now.length) return true;
    return now.some((entry, i) => entry.mtimeMs !== proc.configSnapshot[i].mtimeMs);
  }

  /** 停指定会话的 pi(不传 = 激活会话);其他会话进程不动。 */
  async stop(sessionPath?: string | null): Promise<void> {
    const key = sessionPath != null ? this.resolveProcKey(sessionPath) : this.activeKey;
    const proc = this.procs.get(key);
    if (!proc) return;
    await proc.backend.stop();
    this.procs.delete(key);
    if (key === this.activeKey) this.latestSnapshot = null;
  }

  /** 停所有会话的 pi(应用退出兜底)。 */
  async stopAll(): Promise<void> {
    const ps = [...this.procs.values()].map((p) => p.backend.stop().catch(() => {}));
    await Promise.all(ps);
    this.procs.clear();
    this.latestSnapshot = null;
  }

  /**
   * 发送前的进程保证:激活会话的 pi 在跑。没起 → 起;不杀其他会话进程。
   * 新会话(activeSessionPath=null)时:生成新文件路径传给 pi(--session <path>),
   * pi 底座拿到不存在的文件会建新会话。否则 pi 续该 cwd 桶下最新会话(非新会话语义)。
   */
  private async ensureForSend(): Promise<void> {
    if (!this.activeCwd) throw new Error("未选择工作目录");
    const warming = this.warmups.get(this.activeProcKey);
    if (warming) {
      try {
        await warming;
      } catch {
      }
    }
    if (this.alive) {
      // 配置依赖过期(models.json/settings.json 变过)→ 停旧进程重建:
      // 底座模型快照 spawn 时定型,复用旧进程 set_model 必失败(docs/design/models-config-reload.md)。
      const proc = this.activeProc();
      if (proc && !this.isConfigStale(proc)) return;
      await this.stop(this.activeSessionPath ?? null)
        .catch((e) => console.warn("[session-store] 配置过期停进程失败,下次发起再校验:", e));
    }
    // 新会话(null):生成新文件路径(~/.pi/agent/sessions/<桶>/<timestamp>_<uuid>.jsonl)
    let sessionPath = this.activeSessionPath ?? undefined;
    if (!sessionPath) {
      sessionPath = this.generateNewSessionPath(this.activeCwd);
      this.activeSessionPath = sessionPath;
      // 生成即水合(根因修复,勿回退):立即推 synthetic sessionStart 让 renderer 写入
      // useUiStore.currentSessionPath。此前水合只在 prompt 发送成功后做,而 pref flush
      // (setModel/setThinkingLevel)先于 prompt 走 ensureForSend 起了进程却没水合 →
      // sendText 仍判 currentSessionPath=null → 二次 startNewChat → setContext(cwd,null)
      // 把 activeProcKey 重置走、prompt 的 ensureForSend 再 spawn 第二个进程(双 spawn,
      // pref flush 那个成孤儿)。水合前置后 sendText 跳过 startNewChat,prompt 复用同一进程。
      this.dispatch(this.activeProcKey, { type: "sessionStart", sessionFile: sessionPath });
    }
    await this.start(this.activeCwd, sessionPath);
    // 并发收尾校验:start 的 await 窗口内若并发 setContext 把 activeSessionPath 换走,
    // 发送目标已失效——给准确错误,而非让后续 activeProc() 落空抛误导性的"pi 未启动"。
    if (this.activeSessionPath !== sessionPath) throw new Error("发送期间会话上下文已切换,请重试");
  }

  /** 生成新会话文件路径(对齐 pi 底座格式:ISO timestamp + uuid)。 */
  private generateNewSessionPath(cwd: string): string {
    const sessionsRoot = `${this.agentDir}/sessions`;
    const bucket = cwdToBucketName(cwd);
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const uuid = randomUUID();
    return `${sessionsRoot}/${bucket}/${ts}_${uuid}.jsonl`;
  }

  // ---- SessionsApi 文件类方法:委托给 session-scanner(纯文件操作,不启 pi 进程)----
  // SessionStore 作为 SessionsApi 的聚合实现点,文件操作委托同模块 scanner 函数。
  // 进程类操作(start/stop/sync 等)由本类直接实现,文件类操作(list/openSession/...)委托。
  // 这样 SessionsApi 契约名副其实,IPC 边界可统一经 SessionStore 调用(消除 shell 直连 scanner 的散点)。
  async list(cwd: string): Promise<SessionInfo[]> {
    return listSessions(this.agentDir, cwd);
  }
  async openSession(sessionPath: string): Promise<SessionDetail | null> {
    const detail = await readSession(sessionPath);
    if (detail) {
      this.enrichContextUsage(detail, sessionPath);
      await this.nameOnOpenIfMissing(detail);
    }
    return detail;
  }

  /** 文件基线的上下文占用补全,两个文件外数据源:
   *  窗口:会话文件只有模型证据(model_change/assistant.provider+model,scanner 已按底座
   *    getSessionContextSettings 同算法提取),窗口在 models.json——两头都在盘上,纯文件
   *    即可算出 percent,切会话不等 pi 预热也准确展示;RPC 真值到达后覆盖(同模型同窗口
   *    同算法,不跳变)。证据缺失(旧格式文件)回落头行模型偏好;配置里查不到该模型保持 0=未知。
   *  tokens:scanner 锚点只在真测到 prompt 时产出;锚缺失(供应商不报)时经
   *    resolveContextUsage 用 context-probe 的请求侧实测兜底,皆无则诚实未知。 */
  private enrichContextUsage(detail: SessionDetail, sessionPath: string): void {
    const stats = detail.stats;
    if (!stats) return;
    const cu = stats.contextUsage;
    let contextWindow = cu?.contextWindow ?? 0;
    if (contextWindow <= 0) {
      const ev = detail.modelEvidence ?? parseSessionModelPrefs(detail.info.custom ?? undefined);
      const cw = ev
        ? this.modelsStore.get().providers[ev.provider]?.models?.find((m) => m.id === ev.modelId)?.contextWindow
        : undefined;
      if (typeof cw === "number" && cw > 0) contextWindow = cw;
    }
    if (cu && cu.tokens != null) {
      // 锚点可信:tokens 不动,只补窗口并现算 percent(文件里不存窗口,scanner 恒给 0)
      if (cu.contextWindow <= 0 && contextWindow > 0) {
        cu.contextWindow = contextWindow;
        cu.percent = (cu.tokens / contextWindow) * 100;
      }
      return;
    }
    stats.contextUsage = resolveContextUsage(
      cu ? { ...cu, contextWindow } : { tokens: null, contextWindow, percent: null },
      false,
      readContextProbeTokens(this.agentDir, sessionPath),
    );
  }

  /** 打开即补命名:CLI/别的客户端建的会话无名(无 session_info 条目),
   *  经本入口打开时用首条 user 消息派生名字,追加 session_info 条目(名字单轨,
   *  与 prompt 时自动命名同轨,scanner 以最后一条 session_info 为准)。
   *  仅在该会话无存活 pi 进程时写文件——活着的会话由 prompt 时自动命名(RPC)覆盖,
   *  守住「活跃路径不动文件」的竞态结论(docs/design/session-name-tracks.md)。
   *  已知缺口(内容层边界):timeline 注入的 [System] 工具限制前缀属插件内容,内核不认,
   *  若首条 user 消息带此前缀,派生名会带上它——与 prompt 时自动命名同款既有取舍。 */
  private async nameOnOpenIfMissing(detail: SessionDetail): Promise<void> {
    if (detail.info.name) return;
    if (this.isAlive(detail.info.path)) return;
    const firstUser = detail.messages.find((m) => m.role === "user");
    const text = firstUser ? messageContentText(firstUser.content) : "";
    if (!text.trim()) return;
    const name = truncateSessionName(text);
    try {
      await renameSessionFile(detail.info.path, name);
      detail.info.name = name;
    } catch (e) {
      console.error("[session-store] 打开补命名失败:", { path: detail.info.path, name, error: e });
    }
  }

  async renameSession(sessionPath: string, name: string): Promise<void> {
    if (name && sessionPath === this.activeSessionPath && this.alive) {
      const proc = this.activeProc()!;
      await this.asPi(proc).setSessionName(name);
    } else {
      await renameSessionFile(sessionPath, name);
    }
  }
  async updateHeader(sessionPath: string, patch: HeaderPatch): Promise<void> {
    if (patch.name && sessionPath === this.activeSessionPath && this.alive) {
      const proc = this.activeProc()!;
      await this.asPi(proc).setSessionName(patch.name);
      const rest = { ...patch };
      delete rest.name;
      if (Object.keys(rest).length > 0) await updateSessionHeader(sessionPath, rest);
    } else {
      await updateSessionHeader(sessionPath, patch);
    }
  }
  async copySession(srcPath: string, targetPath: string): Promise<void> {
    copySessionFile(srcPath, targetPath);
  }
  async deleteSessions(paths: string[]): Promise<void> {
    // 活跃会话禁止删除:进程 append 会让文件复活,删了也白删(机制兜底,UI 侧另有 deletable 过滤)
    const targets = paths.filter((p) => p !== this.activeSessionPath);
    if (targets.length > 0) await deleteSessionFiles(targets);
  }
  async readToolConfig(sessionPath: string): Promise<SessionToolConfig | null> {
    return readSessionToolConfig(sessionPath);
  }
  async projectStats(cwd: string): Promise<ProjectStats> {
    return getProjectStats(this.agentDir, cwd);
  }

  /** 底座 lineage 树(§2.4.2):委托激活会话的 BaseBackend.getTree。 */
  async getTree(sessionId: string): Promise<LineageTree> {
    const proc = this.activeProc();
    if (!proc || !proc.backend.alive) throw new Error("底座未启动");
    return proc.backend.getTree(sessionId);
  }

  /** 底座 bookmark(§2.4.4):委托激活会话的 BaseBackend.bookmark。 */
  async bookmark(lineageId: string, boundary: string): Promise<Anchor> {
    const proc = this.activeProc();
    if (!proc || !proc.backend.alive) throw new Error("底座未启动");
    return proc.backend.bookmark(lineageId, boundary);
  }

  /** 底座 resume(§2.4.5):委托激活会话的 BaseBackend.resume。 */
  async resume(anchor: Anchor): Promise<string> {
    const proc = this.activeProc();
    if (!proc || !proc.backend.alive) throw new Error("底座未启动");
    if (proc.backend instanceof PiBackend) {
      // pi 的 resume = forkFromSession 编排:anchor.opaque 是书签拷贝路径、boundary 是分叉点 entryId。
      // 复用 forkFromSession(copy 源 → 中间 → start → fork → 对账 → 删中间)的整套编排。
      const cwd = this.getActiveCwd();
      if (!cwd) throw new Error("无激活 cwd,无法 resume 书签");
      await this.forkFromSession(cwd, anchor.opaque, anchor.boundary, "at");
      const active = this.activeSessionPath;
      if (!active) throw new Error("resume 后未拿到新会话路径");
      return active;
    }
    // 非 pi 后端(dsh):resume = 打开书签 fork 出的子会话。
    return proc.backend.resume(anchor);
  }

  /** 删除书签:委托底座回收后端自留副本。 */
  async deleteBookmark(anchor: Anchor): Promise<void> {
    const proc = this.activeProc();
    if (!proc || !proc.backend.alive) throw new Error("底座未启动");
    await proc.backend.deleteBookmark(anchor);
  }

  /** pi 就绪:150ms get_state 实证探测(§3.6),进程活着时 stdin 缓冲写入,
   *  底座跑通后消费并响应,await 到响应即就绪;进程已死则 send 抛错、下一轮再探。
   *  勿回退加"等 session_start 事件":底座 session_start 是纯扩展事件
   *  (_sessionStartEvent 只经 _extensionRunner.emit 走扩展通道,RPC stdout 永不见),
   *  synthetic sessionStart 经 this.dispatch 直发、不过 backend.onEvent——
   *  事件等待在此永远等不到,此前那套 readyPromise 是从未生效的死代码。 */
  private async waitReady(backend: PiBackend): Promise<void> {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      try {
        await backend.send({ type: "get_state" });
        return;
      } catch {
        // 再等一轮:实证探测继续
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    // 超时也继续:让后续 sync 的真实错误冒出去,不在此掩盖
  }

  /** resync 一次并广播新基线(start 后与显式刷新走这里)。作用于激活会话。 */
  async sync(): Promise<SyncSnapshot> {
    const proc = this.activeProc();
    if (!proc || !proc.backend.alive) throw new Error("pi 未启动");
    const snapshot = await resync(this.asPi(proc));
    // 底座 auto-retry 退避期 get_state.isStreaming 报 false,以 busyStates 记账为准折算。
    snapshot.state.isStreaming = snapshot.state.isStreaming || this.isBusy(this.activeProcKey);
    this.latestSnapshot = snapshot;
    // sync 回写(设计 §4.4):进程≠头时以进程为真相回写头——底座 CLI /model、
    // cycle 命令、扩展自切等旁路变更,最晚在本次 sync 落盘到头。
    // 方向无条件进程→头:onSend 意图在 renderer 内存 pending,回写物理碰不到。
    if (this.activeSessionPath) {
      const fromState = this.modelPrefsFromState(snapshot.state);
      if (fromState) {
        const fromHeader = parseSessionModelPrefs(readSessionCustom(this.activeSessionPath) ?? undefined);
        const same = fromHeader
          && fromHeader.provider === fromState.provider
          && fromHeader.modelId === fromState.modelId
          && fromHeader.thinkingLevel === fromState.thinkingLevel;
        if (!same) await this.writeModelPrefsToHeader(this.activeSessionPath, fromState);
      }
    }
    for (const cb of this.snapshotListeners) {
      try {
        cb(snapshot);
      } catch (err) {
        console.error("[session-store] 快照监听器抛错已隔离:", err);
      }
    }
    return snapshot;
  }

  /** 订阅新基线快照(start/sync 后每次广播一次)。 */
  onSnapshot(cb: (snapshot: SyncSnapshot) => void): () => void {
    this.snapshotListeners.add(cb);
    return () => this.snapshotListeners.delete(cb);
  }

  /** 读当前基线(无基线且 pi 活着时现拉;pi 未启动 reject,调用方走文件读)。 */
  async getSnapshot(): Promise<SyncSnapshot> {
    if (this.latestSnapshot) return this.latestSnapshot;
    return this.sync();
  }

  onEvent(cb: (event: SessionEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  onKernelEvent(cb: (event: KernelEvent) => void): () => void {
    this.kernelListeners.add(cb);
    return () => this.kernelListeners.delete(cb);
  }

  onExtensionUI(cb: (req: { requestId: string; method: string; [k: string]: unknown }) => void): () => void {
    this.extUiListeners.add(cb);
    return () => this.extUiListeners.delete(cb);
  }

  async replyExtensionUI(requestId: string, response: { value?: string; confirmed?: boolean; cancelled?: true }): Promise<void> {
    const proc = this.activeProc();
    if (!proc) throw new Error("pi 未启动");
    this.asPi(proc).sendExtensionUIResponse({
      type: "extension_ui_response", id: requestId,
      value: response.value, confirmed: response.confirmed, cancelled: response.cancelled,
    });
  }

  /** 发消息(唯一会起进程的入口:ensureForSend 后才发)。作用于激活会话。 */
  async prompt(text: string, images?: ImageInput[]): Promise<void> {
    await this.ensureForSend();
    const proc = this.activeProc();
    if (!proc) throw new Error("pi 未启动");
    await this.asPi(proc).sendMessage(text, images);
    proc.touched = true; // 已落会话内容:多会话并存保护,不再被 setContext 回收
    // 发送确立"当前会话流":推给 renderer 水合 useUiStore.currentSessionPath
    // (根因修复,勿回退):底座 session_start 是纯扩展事件,永远不会出现在 RPC
    // stdout 流里,renderer 永远等不到底座推出→useUiStore.currentSessionPath
    // 恒 null→renderer sendText 每次发送都走 startNewChat 分支→ensureForSend
    // 每次生成全新 sessionPath→笔记/常用语连点两次=两个新会话。修复:发送
    // 成功后 main 主动推 synthetic sessionStart,renderer 现有 onEvent 分支
    // 直接水合;已发出的发送目标就是当前会话流,再发一条基于当前会话续发。
    if (this.activeSessionPath) {
      this.dispatch(this.activeProcKey, { type: "sessionStart", sessionFile: this.activeSessionPath });
    }
    // 自动命名条件是"活跃会话还没有名字"而非"新会话":真实使用多为 CLI 建会话、
    // desktop 打开续聊,wasNewSession(activeSessionPath===null) 恒 false,autoName 永不触发。
    // latestSnapshot.state.sessionName 由 dispatch 对 sessionInfoChanged 的增量 patch 保持新鲜,
    // 故手动 rename 后不会被自动命名覆盖;清空后重发消息会重新自动命名(已知取舍,见
    // docs/design/session-name-tracks.md §4.4)。
    if (this.activeSessionPath && !this.latestSnapshot?.state.sessionName) {
      const autoName = truncateSessionName(text);
      if (autoName) {
        try {
          // 走 piSend 而非 proc.backend.sendMessage:复用其 rpcError 上报(dispatchKernel),
          // 失败从静默 console.error 变为 renderer 可订阅的 kernel 事件。
          await this.piSend((pi) => pi.setSessionName(autoName));
          if (this.latestSnapshot) this.latestSnapshot.state.sessionName = autoName;
        } catch (e) {
          console.error("[session-store] 自动命名失败:", { path: this.activeSessionPath, name: autoName, error: e });
        }
      }
    }
  }

  async abort(): Promise<void> {
    const proc = this.activeProc();
    if (!proc || !proc.backend.alive) return;
    // 双保险(根因修复):agent.abort 只中断 agent loop 内的工具(经 signal);
    // executeBash 路径(type:"bash" 直接命令)持独立 abortController,agent.abort 不覆盖,
    // 需 abort_bash 单独中断。顺序不能反:abort 会等 waitForIdle,工具不响应时阻塞,
    // abort_bash 排在后面永远执行不到——先发 abort_bash 快速中断 bash,再发 abort 收尾 agent。
    await this.asPi(proc).abortBash().catch(() => {});
    try {
      await proc.backend.abort();
    } catch {
      // abort 超时(工具未响应 agent signal 中断,如 Windows taskkill 偶发失败)
      // → 杀进程强制停止:进程死了工具必停;会话是文件,重启即恢复,不丢数据。
      proc.backend.stop().catch(() => {});
    }
  }

  async getModels(): Promise<ModelInfo[]> {
    const res = (await this.piSend((pi) => pi.getModels())) as RpcResponse & {
      data?: { models?: Model[] };
    };
    const models = (res.data as { models?: Model[] } | undefined)?.models ?? [];
    return models.map(toModelInfo);
  }

  /** 双写第二半(设计 §4.1):RPC 成功后把全量三字段写进头行 model 域。
   *  patch 失败不阻塞(锁超时/磁盘错误/文件未落盘)——头短暂落后是投影合法态,
   *  文件未落盘时记 proc.pendingModelPrefs 待 messageStart 补写,其余交 sync 回写收敛。 */
  private async writeModelPrefsToHeader(sessionPath: string, prefs: SessionModelPrefs): Promise<void> {
    // 文件未落盘是 warmup 设计内瞬态(pi 进程首发才创建文件):记 pending 待 messageStart
    // 补写,安静返回——不为合法瞬态打错误堆栈(此前每次启动都误报"会话文件不存在")。
    if (!existsSync(sessionPath)) {
      const proc = [...this.procs.values()].find((p) => p.boundSessionPath === sessionPath);
      if (proc) proc.pendingModelPrefs = prefs;
      return;
    }
    try {
      await updateSessionHeader(sessionPath, { custom: { [SESSION_MODEL_PREFS_KEY]: prefs } });
    } catch (e) {
      const proc = [...this.procs.values()].find((p) => p.boundSessionPath === sessionPath);
      if (proc) proc.pendingModelPrefs = prefs;
      console.warn("[session-store] 模型偏好写头降级(待补写或 sync 收敛):", e);
    }
  }

  /** 从快照拼全量三字段;凑不齐(进程未就绪边界)返回 null——交给下一次 sync 回写。 */
  private modelPrefsFromState(state: SyncSnapshot["state"]): SessionModelPrefs | null {
    const model = state.model;
    const level = state.thinkingLevel;
    if (!model || !level) return null;
    return { provider: model.provider, modelId: model.id, thinkingLevel: level };
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    // 根因:旧码进程没活就静默 return,冷启动首条消息的 pref flush 被吞,
    // 会话开在 settings.json 默认模型上。对齐 cycleModel:未起则起。
    await this.ensureForSend();
    const proc = this.activeProc();
    if (!proc) throw new Error("pi 未启动");
    // 差量执行(勿回退):ensureForSend 后快照是进程实况的实证探测(起进程即 sync,
    // §3.6)——进程已持目标值时同值 set_model 是纯噪声(底座会在时间线落 model_change
    // 分隔线,"只改了思考强度却冒出模型切换"即此)。跳过头收敛照旧:值已在进程生效,
    // 写头不违反 §4.1"头不记未生效值";快照缺失(实况未知)则回落为必发。
    const cur = this.latestSnapshot?.state.model;
    const alreadyEffective = !!cur && cur.provider === provider && cur.id === modelId;
    if (!alreadyEffective) {
      await proc.backend.setModel(provider, modelId);
    }
    // 双写(设计 §4.1):RPC 拒绝抛错则 patch 不发生——头不会记下从未生效的值;
    // thinkingLevel 用快照现值补齐,守 model 域三字段原子替换(§3.2)。
    const level = this.latestSnapshot?.state.thinkingLevel;
    if (this.activeSessionPath && level) {
      await this.writeModelPrefsToHeader(this.activeSessionPath, { provider, modelId, thinkingLevel: level });
    }
    // model_select 同 sessionStart 一类(纯扩展事件,RPC stdout 收不到,见 prompt 处
    // 根因注释):不等底座事件,发完 set_model 立即 sync 一次取真实 state.model
    // (事件驱动于 RPC 完成,非 sleep/轮询;fire-and-forget 不阻塞调用方)。
    if (!alreadyEffective) void this.sync().catch(() => {});
  }

  /** 模型连通性测试(ModelApi.test):起独立临时进程发一条 ping。
   *  与激活会话完全隔离——不设 activeProcKey、不走 sync/基线、事件只进运维流,时间线无感。
   *  判定:assistant messageEnd 无 error=通;set_model 响应失败 / 消息带 error /
   *  进程退出 / RPC 错 / 超时 = 不通,原文带回。
   *  零残留靠不落盘(--no-session → 底座 SessionManager.inMemory 内存会话),
   *  而非"测完删文件":删除依赖 boundSessionPath,它只能由 sessionStart 事件写入,
   *  而底座 session_start 是纯扩展事件 RPC stdout 永不见(见 waitReady 注释)、
   *  测试路径又无 synthetic dispatch——旧实现的清理从未执行,每次测试都在
   *  sessions/ 留一个 ping 文件并被 session-scanner 扫进会话列表(实证)。 */
  async test(cwd: string, provider: string, modelId: string, timeoutMs = 60000): Promise<ModelTestResult> {
    if (!cwd) return { ok: false, error: "no working directory" };
    // 独立 proc key(`test:` 前缀永不与会话路径冲突);事件经 dispatch 走 keyed/运维流。
    const key = `test:${randomUUID()}`;
    const proc = this.createProc(key, cwd, null, ["--no-session"]);
    this.procs.set(key, proc);
    try {
      await proc.backend.start();
      await this.waitReady(this.asPi(proc));
      // set_model 是同步 RPC:provider/模型 id 不存在时底座回 success:false,
      // backend  reject(RpcCommandError)——转成 ModelTestResult 契约,不外抛。
      try {
        await proc.backend.setModel(provider, modelId);
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      // 先订阅再发 ping,不竞态(事件在先,请求在后)。
      const reply = this.awaitTestReply(key, timeoutMs);
      await proc.backend.sendMessage("ping");
      return await reply;
    } finally {
      try { await proc.backend.stop(); } catch (e) { console.warn(`[session-store] test proc stop failed:`, e); }
      this.procs.delete(key);
    }
  }

  /** 等 test 会话的 ping 结果:只订阅 key 匹配的 keyed 事件流 + 内核进程事件,超时兜底。 */
  private awaitTestReply(key: string, timeoutMs: number): Promise<ModelTestResult> {
    return new Promise((resolve) => {
      let resolved = false;
      const finish = (result: ModelTestResult): void => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        offKeyed();
        this.kernelListeners.delete(onKernel);
        resolve(result);
      };
      const timer = setTimeout(() => finish({ ok: false, error: `timeout ${Math.round(timeoutMs / 1000)}s` }), timeoutMs);
      const offKeyed = this.onSessionEvent(key, (event) => {
        if (event.type === "messageEnd") {
          const msg = (event as { message?: NeutralMessage }).message;
          if (msg?.error) return finish({ ok: false, error: extractMessageError(msg) });
          if (msg?.role === "assistant") return finish({ ok: true });
        }
        if (event.type === "agentEnd" || event.type === "agentSettled") {
          finish({ ok: false, error: "no response" });
        }
      });
      const onKernel = (event: KernelEvent): void => {
        if ((event as { sessionKey?: string }).sessionKey !== key) return;
        if (event.source === "desktop" && event.kind === "processExit" && !event.expected) {
          finish({ ok: false, error: `process exited (code ${event.code})` });
        }
        if (event.source === "desktop" && event.kind === "rpcError") {
          finish({ ok: false, error: event.message });
        }
      };
      this.kernelListeners.add(onKernel);
    });
  }

  async getThinkingLevels(): Promise<string[]> {
    const res = (await this.piSend((pi) => pi.getThinkingLevels())) as RpcResponse & {
      data?: unknown;
    };
    const data = res.data as { levels?: unknown } | string[] | undefined;
    const levels = Array.isArray(data) ? data : data?.levels;
    return Array.isArray(levels) ? levels.map(String) : [];
  }

  async setThinkingLevel(level: string): Promise<void> {
    // 根因同 setModel:进程没活不能静默 return(pref flush 被吞),未起则起。
    await this.ensureForSend();
    const proc = this.activeProc();
    if (!proc) throw new Error("pi 未启动");
    // 差量执行同 setModel:进程已持目标档位时同值 RPC 是纯噪声(底座落
    // thinking_level_change 分隔线),跳过;快照缺失(实况未知)回落为必发。
    if (this.latestSnapshot?.state.thinkingLevel !== level) {
      await this.asPi(proc).setThinkingLevel(level as never);
    }
    // 双写(设计 §4.1):provider/modelId 用快照现值补齐,守 model 域三字段原子替换(§3.2)。
    const model = this.latestSnapshot?.state.model;
    if (this.activeSessionPath && model) {
      await this.writeModelPrefsToHeader(this.activeSessionPath, { provider: model.provider, modelId: model.id, thinkingLevel: level });
    }
  }

  /** 会话统计(底座 get_session_stats):token 用量/上下文占用/消息计数/cost + 自算 tps/轮次用量。 */
  async getStats(): Promise<SessionStats> {
    const proc = this.activeProc();
    if (!proc || !proc.backend.alive) throw new Error("pi 未启动");
    const res = (await this.asPi(proc).getSessionStats()) as RpcResponse & { data?: Record<string, unknown> };
    const stats = toSessionStats(res.data, { tps: proc.lastTps, turn: proc.turn, lastTurn: proc.lastTurn });
    // 上下文信任序(resolveContextUsage,契约单源):锚不可信(供应商不报 prompt token)时
    // 用 context-probe 的请求侧实测兜底,再无可信来源则诚实未知——不放行底座的假锚点。
    if (!proc.lastPromptAnchorReal) {
      const measured = proc.boundSessionPath ? readContextProbeTokens(this.agentDir, proc.boundSessionPath) : null;
      stats.contextUsage = resolveContextUsage(stats.contextUsage, false, measured);
    }
    return stats;
  }

  // ============ MessagingApi ============

  async steer(text: string, images?: ImageInput[]): Promise<void> {
    await this.ensureForSend();
    const proc = this.activeProc();
    if (!proc) throw new Error("pi 未启动");
    await this.asPi(proc).steer(text, images);
    proc.touched = true;
  }

  async followUp(text: string, images?: ImageInput[]): Promise<void> {
    await this.ensureForSend();
    const proc = this.activeProc();
    if (!proc) throw new Error("pi 未启动");
    await this.asPi(proc).followUp(text, images);
    proc.touched = true;
  }

  async abortRetry(): Promise<void> {
    const proc = this.activeProc();
    if (!proc || !proc.backend.alive) return;
    await this.asPi(proc).abortRetry();
  }

  // ============ ModelApi ============

  async cycleModel(): Promise<void> {
    await this.ensureForSend();
    const proc = this.activeProc();
    if (!proc) throw new Error("pi 未启动");
    await this.asPi(proc).cycleModel();
  }

  async cycleThinkingLevel(): Promise<void> {
    await this.ensureForSend();
    const proc = this.activeProc();
    if (!proc) throw new Error("pi 未启动");
    await this.asPi(proc).cycleThinkingLevel();
  }

  // ============ SessionTreeApi ============

  async fork(entryId: string, position?: "before" | "at"): Promise<void> {
    // 底座命令级失败(如旧底座不认识 position、assistant 锚点撞 "before" 的 role 校验)
    // 由 rpc-adapter reject 抛上来;这里再兜 success:true 但 cancelled 的路径
    // (session_before_fork 扩展拦截)——两种都是失败,不许静默当成功。
    const res = (await this.piSend((pi) => pi.forkCommand(entryId, position))) as RpcResponse & {
      data?: { cancelled?: boolean };
    };
    if (res.data?.cancelled) throw new Error("fork 被取消(底座扩展拦截)");
    await this.reconcileAfterSessionReplacement();
  }

  async clone(): Promise<void> {
    await this.piSend((pi) => pi.clone());
    await this.reconcileAfterSessionReplacement();
  }

  /** 从任意会话文件分叉(契约语义=开新会话+预制内容,见 domain SessionTreeApi)。
   *  编排:复制源文件到中间路径(generateNewSessionPath——注入的 agentDir、当前时间戳命名)
   *  → start → fork(内部对账到分叉产物)→ 删中间副本。
   *  失败回滚:恢复先前上下文、停掉跑在中间副本上的 pi、删副本——任何失败路径都不留孤儿。
   *  根因:此前该编排放插件侧(session-bookmarks),中间副本永不清理,
   *  会话桶里每 fork 一次积一个"当年时间"的幽灵会话。 */
  async forkFromSession(cwd: string, srcPath: string, entryId: string, position?: "before" | "at"): Promise<void> {
    const prevPath = this.activeSessionPath;
    const intermediate = this.generateNewSessionPath(cwd);
    copySessionFile(srcPath, intermediate);
    try {
      this.setContext(cwd, intermediate);
      await this.start(cwd, intermediate);
      // 竞态护栏(根因修复,勿回退):start 的 await 窗口(spawn+waitReady,1~2s)内并发
      // setContext(点别的会话/⌘N/切目录)会把激活态切走——start 自身的护栏只跳过 sync,
      // 不拦调用方继续走。此后 fork 若仍经环境性 activeProc() 取进程,命令落到别的会话的
      // pi:entryId 不在其会话文件里,底座报 "Invalid entry ID for forking";更劣变体是
      // 目标会话恰好含该 id(如点回了收藏源会话)时静默 fork 错会话。
      // 护栏①:激活态已丢即中止(尚未发 fork,零副作用)。
      if (this.activeSessionPath !== intermediate) {
        throw new Error("fork 被并发上下文切换打断");
      }
      // fork 命令钉在本次启动的 proc 上(send 第二参),不经环境性 activeProc()——
      // 命令必达加载中间副本的那个 pi,别的会话物理上收不到。
      const proc = this.activeProc();
      const res = (await this.piSend((pi) => pi.forkCommand(entryId, position), proc ?? undefined)) as RpcResponse & {
        data?: { cancelled?: boolean };
      };
      if (res.data?.cancelled) throw new Error("fork 被取消(底座扩展拦截)");
      // 护栏②:fork 已执行(产物落会话桶),激活态在 send 窗口内被切走——
      // 不劫持用户当前上下文,走 catch 清理中间副本;产物留列表里可自行打开。
      if (this.activeSessionPath !== intermediate) {
        throw new Error("fork 被并发上下文切换打断");
      }
      await this.reconcileAfterSessionReplacement();
      // "at" 语义下 fork 成功必切换到底座新建的分叉产物;未切换=失败(根因:旧码把
      // 未切换当合法跳过——RPC 错误响应被 backend 当正常值放行时,fork 实际没发生,
      // UI 静默停在中间副本(源会话的逐字节拷贝)上继续聊,中间副本还泄漏成僵尸)。
      // 未切换走 catch 统一回滚,没有"不删"的例外。
      if (this.activeSessionPath === intermediate) {
        throw new Error("fork 未生效:底座未切换到新会话");
      }
      await deleteSessionFiles([intermediate]);
      // 删文件无内核事件,列表里中间副本那行会残留成僵尸(点开文件已不在)——
      // 补播一次 sessionStart 触发重扫;值未变,renderer 水合是幂等 no-op
      const active = this.activeSessionPath;
      if (active) this.dispatch(this.activeProcKey, { type: "sessionStart", sessionFile: active });
    } catch (err) {
      // 激活态还停在中间副本才恢复先前上下文;被外部切走(竞态护栏抛出)则尊重
      // 用户的选择,不拽回。
      if (this.activeSessionPath === intermediate) this.setContext(cwd, prevPath);
      await this.stop(intermediate).catch(() => {});
      await deleteSessionFiles([intermediate]).catch(() => {});
      throw err;
    }
  }

  /** fork/clone 后的对账:底座切换会话文件不推事件(session_start 是纯扩展事件,RPC stdout
   *  永不见;fork 响应也不带新路径),框架须主动 sync 拿 get_state.sessionFile 切激活路径,
   *  并推 synthetic sessionStart 水合 renderer——否则 UI 停在 fork 前路径,
   *  prompt 时 sessionStart 还会把过期路径再播一遍(调用方各自 sync 是补丁且修不到路径)。
   *  rekeyProc 同步把进程条目迁到新路径(key === boundSessionPath 不变量)。 */
  private async reconcileAfterSessionReplacement(): Promise<void> {
    const snapshot = await this.sync();
    const sf = snapshot.state.sessionFile;
    if (typeof sf !== "string" || !sf || sf === this.activeSessionPath) return;
    this.activeSessionPath = sf;
    const proc = this.activeProc();
    if (proc) this.rekeyProc(proc, sf);
    this.dispatch(this.activeProcKey, { type: "sessionStart", sessionFile: sf });
  }

  async getForkMessages(entryId: string): Promise<NeutralMessage[]> {
    const res = (await this.piSend((pi) => pi.getForkMessages(entryId))) as RpcResponse & {
      data?: { messages?: { role: string; content?: unknown; timestamp?: number }[] };
    };
    const messages = (res.data as { messages?: unknown[] } | undefined)?.messages ?? [];
    return deduplicateAdjacent(
      (messages as NeutralMessage[]).filter(isVisibleMessage),
    );
  }

  // ============ SessionMaintenanceApi ============

  async compact(customInstructions?: string): Promise<void> {
    await this.piSend((pi) => pi.compact(customInstructions));
  }

  async setAutoCompaction(enabled: boolean): Promise<void> {
    await this.piSend((pi) => pi.setAutoCompaction(enabled));
  }

  async setAutoRetry(enabled: boolean): Promise<void> {
    await this.piSend((pi) => pi.setAutoRetry(enabled));
  }

  async exportHtml(outputPath?: string): Promise<string> {
    const res = (await this.piSend((pi) => pi.exportHtml(outputPath))) as RpcResponse & {
      data?: { path?: string } | string;
    };
    if (typeof res.data === "string") return res.data;
    return (res.data as { path?: string } | undefined)?.path ?? "";
  }

  async getLastAssistantText(): Promise<string> {
    const res = (await this.piSend((pi) => pi.getLastAssistantText())) as RpcResponse & {
      data?: { text?: string } | string;
    };
    if (typeof res.data === "string") return res.data;
    return (res.data as { text?: string } | undefined)?.text ?? "";
  }

  // ============ QueueModeApi ============

  async setSteeringMode(mode: "all" | "one-at-a-time"): Promise<void> {
    await this.piSend((pi) => pi.setSteeringMode(mode));
  }

  async setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<void> {
    await this.piSend((pi) => pi.setFollowUpMode(mode));
  }

  // ============ BashApi ============

  async run(command: string, opts?: { excludeFromContext?: boolean }): Promise<BashResult> {
    const res = (await this.piSend((pi) => pi.bash(command, opts?.excludeFromContext))) as RpcResponse & {
      data?: { stdout?: string; stderr?: string; exitCode?: number };
    };
    const data = res.data as { stdout?: string; stderr?: string; exitCode?: number } | undefined;
    return {
      stdout: data?.stdout ?? "",
      stderr: data?.stderr ?? "",
      exitCode: data?.exitCode ?? 0,
    };
  }

  async abortBash(): Promise<void> {
    await this.piSend((pi) => pi.abortBash());
  }

  /** 原样发 RPC 命令(壳内高级用途;插件不暴露,插件走意图方法)。默认作用于激活会话;
   *  target 显式钉进程时用 target(forkFromSession 竞态护栏的唯一消费点——跨 await 的
   *  多步编排不能经环境性 activeProc() 取进程,见该方法注释)。 */
  /** pi 专属命令发送 + rpcError 上报(语义收编后:pi 专属命令经此助手,中性操作走 proc.backend)。 */
  private piSend(fn: (pi: PiBackend) => Promise<RpcResponse>, target?: SessionProc): Promise<RpcResponse> {
    const proc = target ?? this.activeProc();
    if (!proc || !proc.backend.alive) throw new Error("pi 未启动");
    const key = target?.key ?? this.activeKey;
    const pi = this.asPi(proc);
    return fn(pi).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      const reason = err instanceof Error && (err as { code?: string }).code === "timeout" ? "timeout" : "sendError";
      this.dispatchKernel({ source: "desktop", kind: "rpcError", reason, message, sessionKey: key });
      throw err;
    });
  }

  /** 类型守卫:当前后端必须是 PiBackend(pi 专属命令的前提)。 */
  private asPi(proc: SessionProc): PiBackend {
    if (!(proc.backend instanceof PiBackend)) throw new Error("当前后端不支持 pi 专属命令");
    return proc.backend;
  }

  /** 事件路由(多会话并存的核心纪律):
   *  - 状态跟踪(busy/TPS/boundSessionPath):按事件来源 key 记账,与激活无关。
   *  - 运维流(dispatchKernel + keyedListeners):激活会话全量;后台会话转非流式增量事件
   *    (agentStart/messageStart/messageEnd/toolCallStart/toolCallEnd/autoRetry与compaction对/
   *    entryAppended/agentEnd/agentSettled/sessionStart,带 sessionKey),仍排除 messageUpdate 与
   *    toolCallUpdate 两个 token 级刷屏源(设计 docs/design/session-working-phase.md §2.2)。
   *    消费方:会话栏经此推后台阶段与未读增量、restart 经 keyedListeners 等。
   *  - 视图流(listeners,即插件的 sessions.onEvent):只转激活会话——后台会话的任何事件
   *    都不得污染当前时间线(此前 messageEnd 全转发,renderer 无 key 可用,会用别的会话的
   *    消息覆盖当前视图末条、用背景会话的 agentSettled 提前熄掉 streaming,见评估 A)。
   *  TPS 自算:messageStart 记时,messageEnd 用 output tokens / 耗时算 tps(底座不给 TPS)。 */
  private dispatch(key: string, event: SessionEvent): void {
    const proc = this.procs.get(key);
    if (event.type === "sessionStart") {
      const sf = event.sessionFile;
      if (typeof sf === "string" && sf && proc) {
        proc.boundSessionPath = sf;
        // activeSessionPath 只属于激活会话——背景会话的 sessionStart(如重启重载)不得改写
        if (key === this.activeProcKey) this.activeSessionPath = sf;
      }
    }
    if (event.type === "sessionInfoChanged" && key === this.activeProcKey && this.latestSnapshot) {
      // 基线增量:改名即时反映到 latestSnapshot.state.sessionName——prompt() 的自动命名
      // 判定(无名字才命名)依赖基线新鲜;不走全量 sync(事件驱动,见 §5.3 收敛)。
      // 显式收窄:SessionEvent 联合末尾的宽松兑底成员使 case 判别不自动窄化,与 renderer 同一手法。
      // sessionName 已由 gateway 翻译器规范化(空名→undefined),此处直接赋值。
      this.latestSnapshot.state.sessionName = (event as { sessionName?: string }).sessionName;
    }
    if (event.type === "agentStart") {
      this.busyStates.set(key, true);
      if (proc) {
        proc.roundOut = 0; proc.roundGenSec = 0;
        // 翻轮:有真实消耗才归档——中止的空轮(无 messageEnd 落地 usage)不抹掉有效历史。
        if (proc.turn.input + proc.turn.output + proc.turn.cacheRead + proc.turn.cacheWrite > 0) {
          proc.lastTurn = proc.turn;
        }
        proc.turn = zeroTurnUsage();
      }
    } else if (event.type === "agentSettled") {
      this.busyStates.set(key, false);
    } else if (event.type === "autoRetryStart") {
      this.busyStates.set(key, true);
    } else if (event.type === "autoRetryEnd") {
      // success=true:恢复生成,收尾交 agentSettled;false/取消:重试终结,清算。
      if ((event as { success?: boolean }).success !== true) this.busyStates.set(key, false);
    } else if (event.type === "compactionStart") {
      this.busyStates.set(key, true);
    } else if (event.type === "compactionEnd") {
      this.busyStates.set(key, false);
    }
    if (proc) {
      if (event.type === "messageStart") {
        proc.genStartMs = Date.now();
        // 双写降级账补写(§4.5):底座处理了消息即会话文件必已落盘,
        // 此前因文件未建而降级的模型偏好在此补写清账(幂等,失败仍降级)。
        if (proc.pendingModelPrefs && proc.boundSessionPath) {
          const prefs = proc.pendingModelPrefs;
          const path = proc.boundSessionPath;
          proc.pendingModelPrefs = undefined;
          void this.writeModelPrefsToHeader(path, prefs);
        }
      } else if (event.type === "messageEnd" && proc.genStartMs != null) {
        const elapsed = (Date.now() - proc.genStartMs) / 1000;
        const u = messageUsageOf(event.message);
        const out = u?.tokens.output ?? 0;
        proc.roundOut += out;
        proc.roundGenSec += elapsed;
        proc.lastTps = proc.roundGenSec > 0 && proc.roundOut > 0 ? proc.roundOut / proc.roundGenSec : null;
        proc.genStartMs = null;
        if (u) {
          proc.turn.input += u.tokens.input; proc.turn.output += u.tokens.output;
          proc.turn.cacheRead += u.tokens.cacheRead; proc.turn.cacheWrite += u.tokens.cacheWrite;
          proc.turn.cost += u.cost;
          const m = event.message as { role?: unknown; stopReason?: unknown };
          if (m.role === "assistant" && m.stopReason !== "aborted" && m.stopReason !== "error") {
            proc.lastPromptAnchorReal = u.tokens.input + u.tokens.cacheRead + u.tokens.cacheWrite > 0;
          }
        }
      }
    }
    // 运维流:激活全量、后台转非流式增量(设计 docs/design/session-working-phase.md §2.2;
    // 白名单仍排除 messageUpdate/toolCallUpdate 两个 token 级刷屏源)
    const isBackgroundEvent =
      event.type === "agentStart" ||
      event.type === "messageStart" ||
      event.type === "messageEnd" ||
      event.type === "toolCallStart" ||
      event.type === "toolCallEnd" ||
      event.type === "autoRetryStart" ||
      event.type === "autoRetryEnd" ||
      event.type === "compactionStart" ||
      event.type === "compactionEnd" ||
      event.type === "entryAppended" ||
      event.type === "agentEnd" ||
      event.type === "agentSettled" ||
      event.type === "sessionStart";
    if (key === this.activeProcKey || isBackgroundEvent) {
      this.dispatchKernel({ source: "pi", kind: "session", sessionKey: key, event });
    }
    for (const cb of this.keyedListeners) {
      try { cb(event, key); } catch (err) { console.error("[session-store] keyed 监听器抛错已隔离:", err); }
    }
    // 视图流:仅激活会话
    if (key !== this.activeProcKey) return;
    for (const cb of this.listeners) {
      try { cb(event); } catch (err) { console.error("[session-store] 事件监听器抛错已隔离:", err); }
    }
  }

  private dispatchKernel(event: KernelEvent): void {
    for (const cb of this.kernelListeners) {
      try { cb(event); } catch (err) { console.error("[session-store] kernel event 监听器抛错已隔离:", err); }
    }
  }

  // ============ SessionStoreForRestart(§6.6) ============

  isBusy(sessionKey: string): boolean {
    return this.busyStates.get(sessionKey) ?? false;
  }

  onSessionEvent(sessionKey: string, cb: (event: SessionEvent) => void): () => void {
    // 按事件来源 key 过滤(此前错拿 activeProcKey 比,后台会话的订阅永远不触发,
    // restart-coordinator 等空闲永远等不到 agentSettled——根因修复,勿回退)。
    const wrapper = (event: SessionEvent, key: string) => {
      if (key === sessionKey) cb(event);
    };
    this.keyedListeners.add(wrapper);
    return () => { this.keyedListeners.delete(wrapper); };
  }

  getRunningSessionKeys(): string[] {
    return [...this.procs.keys()].filter((k) => this.procs.get(k)?.backend.alive);
  }

  async restart(sessionKey: string): Promise<void> {
    const proc = this.procs.get(sessionKey);
    if (!proc) return;
    const { cwd, boundSessionPath } = proc;
    await this.stop(sessionKey);
    // 与 start() 同一装配入口:createProc 绑定全部事件(含 extensionUI/processExit)。
    const newProc = this.createProc(sessionKey, cwd, boundSessionPath);
    this.procs.set(sessionKey, newProc);
    await newProc.backend.start();
    await this.waitReady(this.asPi(newProc));
    // 只有重启的是激活会话才重推基线;后台会话重启不打扰当前视图,
    // 且 activeProc 没 alive 时 sync 会 throw 被误判为 restart 失败。
    if (sessionKey === this.activeProcKey) await this.sync();
  }

  getCwdAndSessionPath(sessionKey: string): { cwd: string; sessionPath: string | null } {
    const proc = this.procs.get(sessionKey);
    if (!proc) return { cwd: "", sessionPath: null };
    return { cwd: proc.cwd, sessionPath: proc.boundSessionPath };
  }

  // ============ Session Bus 支撑(路由器经此面驱动任意会话,不涉及激活语义) ============

  /** 全会话事件订阅(带来源 key;keyedListeners 的通用暴露——总线路由器的进线)。 */
  onAnySessionEvent(cb: (event: SessionEvent, sessionKey: string) => void): () => void {
    this.keyedListeners.add(cb);
    return () => { this.keyedListeners.delete(cb); };
  }

  /** $bus 上行帧订阅(createProc 已为每条 backend 绑好转发)。 */
  onBusFrame(cb: (frame: Record<string, unknown>, sessionKey: string) => void): () => void {
    this.busFrameListeners.add(cb);
    return () => { this.busFrameListeners.delete(cb); };
  }

  /** 按 key 取 backend(进程不在返回 undefined)。 */
  getAdapter(sessionKey: string): PiBackend | undefined {
    const backend = this.procs.get(sessionKey)?.backend;
    return backend instanceof PiBackend ? backend : undefined;
  }

  /** 总线 spawn:起一个不抢激活语义的会话进程(key=bus:<uuid8>,全新会话文件)。
   *  opts.role:会话级角色卡——role 文本内联进 argv(--append-system-prompt),createProc 注入。 */
  async spawnSession(cwd: string, opts?: { role?: SessionRole }): Promise<{ key: string; sessionPath: string }> {
    const key = `bus:${randomUUID().slice(0, 8)}`;
    const sessionPath = this.generateNewSessionPath(cwd);
    const proc = this.createProc(key, cwd, sessionPath, [], opts?.role);
    this.procs.set(key, proc);
    await proc.backend.start();
    await this.waitReady(this.asPi(proc));
    return { key, sessionPath };
  }

  /** agentDir 只读暴露:总线会话文件路径圈禁用(agentDir 由 shell 注入,本层不直读环境)。 */
  get agentDirPath(): string {
    return this.agentDir;
  }

  /** 总线续聊:以已有会话文件起进程续上下文(不抢激活语义,key=bus:<uuid8>)。
   *  与 spawnSession 的唯一差异:传已有 sessionPath(--session 续上下文)而非新文件。
   *  role 是进程参数(不持久化在会话文件里)——谁 reopen 谁负责带角色;会话历史已含角色
   *  影响,即使不重传也不会完全失忆。
   *  消费方:对话面板对已完成/离线的子 agent "继续对话"(reopen 后 tap 流式回复)。 */
  async reopenSession(cwd: string, sessionPath: string, role?: SessionRole): Promise<{ key: string; sessionPath: string }> {
    const key = `bus:${randomUUID().slice(0, 8)}`;
    const proc = this.createProc(key, cwd, sessionPath, [], role);
    this.procs.set(key, proc);
    await proc.backend.start();
    await this.waitReady(this.asPi(proc));
    return { key, sessionPath };
  }

  /** 往指定会话注入一条 prompt(streamingBehavior 由调用方按帧型分派:响应=steer,事件=followUp)。 */
  async sendPromptTo(sessionKey: string, text: string, streamingBehavior?: "steer" | "followUp"): Promise<void> {
    const proc = this.procs.get(sessionKey);
    if (!proc || !proc.backend.alive) throw new Error(`会话不在线: ${sessionKey}`);
    await this.asPi(proc).sendMessage(text, undefined, streamingBehavior);
    proc.touched = true;
  }

  /** 按 key 取最后一条 assistant 文本(完成采集主源;进程不在返回空串,调用方回退读文件)。 */
  async getLastAssistantTextFor(sessionKey: string): Promise<string> {
    const proc = this.procs.get(sessionKey);
    if (!proc || !proc.backend.alive) return "";
    // 底座命令级失败(backend reject)同样回退空串——本方法是采集主源,读文件兜底在调用方
    const res = (await this.asPi(proc).getLastAssistantText().catch(() => null)) as (RpcResponse & {
      data?: { text?: string } | string;
    }) | null;
    if (!res) return "";
    if (typeof res.data === "string") return res.data;
    return (res.data as { text?: string } | undefined)?.text ?? "";
  }
}

/** 从带 error 标记的 NeutralMessage 里提取可读错误原语(errorMessage/stopReason 透传字段)。 */
function extractMessageError(message: NeutralMessage): string {
  const m = message as Record<string, unknown>;
  if (typeof m.errorMessage === "string" && m.errorMessage) return m.errorMessage;
  if (typeof m.stopReason === "string" && m.stopReason) return m.stopReason;
  return "model error";
}
