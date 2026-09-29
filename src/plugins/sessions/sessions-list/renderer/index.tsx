// sessions-list 插件 renderer —— 左栏"会话"分组:会话列表 + 搜索 + 新建。
//
// 数据:ctx.sessions.list(currentCwd)(核心会话能力,无需权限声明)。
// 交互:点选 = switchSession + 面包屑标题 + nonce 触发 timeline 重 resync;
// "+" = newSession(直接开,不弹确认)。
// 分组:已置顶(恒在最上,带 Pin)> 时间四档(今天/昨天/过去7天/更早,各可折叠)
//       > 已归档(默认折叠,带 Archive)。pinned/archived 写中立层 header(真相源),
//       内核投影已跳(neutral-storage-split §2.5);写后本地补丁生效,不重拉(§2.6)。
// 状态标识:执行中(onKernelEvent 按 sessionKey 维护 busyMap,messageStart→agentSettled,
// 含后台会话)> 未读(readState 存插件 config,活跃会话自动跟随已读,非活跃有新 entry 亮圆点)。
import { useEffect, useState, useRef, useMemo, useCallback, forwardRef } from "react";
import * as React from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { motion, AnimatePresence } from "framer-motion";
import { useTranslation } from "react-i18next";
import { Plus, Search, FileJson, AppWindow, Pencil, Pin, PinOff, Archive, ArchiveRestore, MessageSquare, X, RotateCw, Check, Trash2, ChevronRight, ChevronDown, TriangleAlert } from "lucide-react";
import { usePluginContext, useUiStore, useSessionStore, useSessionGroupings, Section, SortableList, PluginIcon, type SessionInfo,
  announceTransient, fireAndReport,} from "@my-harness-desktop/react";
import { deriveSessionTitle, applyCustomOrder, advancePhase, scopeKeyFromSessionKey, type WorkingPhase, type SessionRawFilePaths } from "@my-harness-desktop/shared";
import { filterSessions } from "../core/search";
import { PhaseIcon } from "./phase-icon";


/** 工作阶段 → shell.* 文案键（与 timeline 底部指示器共用同一套文案，见 §1.3 契约单源）。 */
const PHASE_LABEL_KEY: Record<string, string> = {
  requesting: "shell.requesting",
  thinking: "shell.thinking",
  toolExecuting: "shell.toolExecuting",
  outputting: "shell.outputting",
  retrying: "shell.retrying",
  compacting: "shell.compacting",
};

/** 头行可选字段补丁(与 updateHeader 契约一致)。 */
type HeaderPatch = { name?: string; pinned?: boolean; archived?: boolean };

/** 渲染分组:pinned(已置顶)/ time(时间档)/ archive(已归档)。 */
type GroupKind = "pinned" | "time" | "archive";
interface Group {
  /** 稳定分组 id,持久化 customOrder 的 key:pinned / today / yesterday / last7days / earlier / archived。 */
  groupId: string;
  label: string;
  items: SessionInfo[];
  kind: GroupKind;
  defaultOpen?: boolean;
}

interface ChildSession {
  session: SessionInfo;
  parentPath: string;
  /** 命中的分组策略所声明的子行图标名（lucide）。缺省 ⇒ 用默认缩进图标（契约：childIcon）。
   *  r71 之前这两个字段**声明了却没人读**：sub-agent 的 manifest 写着
   *  `childIcon: "git-fork"` / `childLabelKey: "sub-agent.childLabel"`，而本插件只读
   *  `parentPathField`，于是子 agent 会话在列表里与普通会话长得一样——
   *  「声明了却不兑现」：用户/插件作者按契约声明，界面毫无反应，且没有任何提示。 */
  childIcon?: string;
  /** 命中的分组策略所声明的子分组标题 i18n 键。缺省 ⇒ 不显子分组标题（契约：childLabelKey）。 */
  childLabelKey?: string;
}

export function SessionsSection(): React.ReactNode {
  const ctx = usePluginContext();
  const { t } = useTranslation();
  /** UI 态落盘（r197，同 r183 的 projects/plugin-manager）：此前是 `void ctx.config.set(...)`
   *  **发射后不管**——已读状态与拖拽排序写失败时静默不落盘、重启后回退且零反馈（§7.6）。
   *  customOrder 尤其是用户动作（拖拽排序，r180 的收藏顺序同族）。收敛成一个助手（§3.3），
   *  失败处置复用框架原语 fireAndReport（r185）。 */
  const persist = (key: string, value: unknown): void => {
    void ctx.config.set(key, value);   // r216 回退：框架层 config.set 已播报（r82）⇒ 插件不再二次处置（r187/r206：处置只应发生一次）
  };

  const {
    currentCwd, currentNeutralSessionId,
    setCurrentSessionPath, setCurrentNeutralSessionId, setSessionTitle,
  } = useUiStore();
  const snapshotAlive = useSessionStore((s) => s.snapshot !== null);
  // 会话元数据收编框架 store(设计 docs/design/plugin-decoupling.md §4.2):
  // 数据源 = sessionInfos(框架拉取 + 事件维护),本插件不再 ctx.sessions.list。
  const sessionInfos = useSessionStore((s) => s.sessionInfos);
  // sessionInfos 是双键映射(同一会话既按 path 又按 neutralSessionId 索引,供事件流按
  // 任意一键回查);渲染列表必须去重——直接 Object.values 会把每条会话画两遍
  // (根因:React duplicate key,列表行翻倍,会话列表观感大乱)。
  const sessions = useMemo(() => {
    const seen = new Set<string>();
    const out: SessionInfo[] = [];
    for (const s of Object.values(sessionInfos ?? [])) {
      const key = s.neutralSessionId ?? s.path;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(s);
    }
    return out;
  }, [sessionInfos]);
  const loading = sessionInfos === null;
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [refreshState, setRefreshState] = useState<"idle" | "refreshing" | "refreshed">("idle");
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // 会话工作阶段:sessionKey(=会话文件路径,新会话为 new:${cwd})→ WorkingPhase。
  // 运维流事件驱动(advancePhase 增量推进,含后台会话),替代旧的 busyByPath 二元忙标志
  // (设计 docs/design/session-working-phase.md §2.3)。
  const [phaseByPath, setPhaseByPath] = useState<Record<string, WorkingPhase>>({});
  // 最新条目 id:sessionPath → 最新 entry id(entryAppended/messageEnd 事件驱动增量)。
  // 未读判定依赖它,与列表 reload 解耦——推进发生在消息到达时刻(设计文档 §3.2)。
  const [lastEntryByPath, setLastEntryByPath] = useState<Record<string, string>>({});
  // 已读位标:sessionPath → 最后一条已读 entry 的 id。存插件 config(plugins-data 私有区,
  // 官方指引的插件私有数据落点);ref 保最新值,防连续 markRead 闭包旧值互相覆盖。
  const [readState, setReadState] = useState<Record<string, string>>({});
  const readStateRef = useRef<Record<string, string>>({});
  // 位标未从盘上读回前禁止推进:markRead 整对象写回,基于空 ref 写会冲掉盘上其他会话的 key。
  const readLoadedRef = useRef(false);
  // 乐观移除:写操作(归档/删除)点击瞬间把行从渲染树摘除,exit 动画即刻播放——
  // 不等待 updateHeader + 重拉两跳 IPC(那期间行纹丝不动,体感「停一会儿才消失」)。
  // 数据源是框架 store,本插件只派生渲染不改 store:标记在权威重拉完成后清空。
  const [removing, setRemoving] = useState<Set<string>>(() => new Set());
  const removingRef = useRef<Set<string>>(new Set());
  const markRemoving = useCallback((path: string): void => {
    if (removingRef.current.has(path)) return;
    const next = new Set(removingRef.current);
    next.add(path);
    removingRef.current = next;
    setRemoving(next);
  }, []);
  const clearRemoving = useCallback((): void => {
    if (removingRef.current.size === 0) return;
    removingRef.current = new Set();
    setRemoving(new Set());
  }, []);
  // 用户拖拽出的组内自定义序:groupId → path 数组(完整可见顺序)。存插件 config,
  // 与 readState 同落点同机制——reload 拉回后 applyCustomOrder 纯函数重建,不丢。
  const [customOrder, setCustomOrder] = useState<Record<string, string[]>>({});
  const customOrderRef = useRef<Record<string, string[]>>({});
  const customOrderLoadedRef = useRef(false);

  useEffect(() => () => clearTimeout(refreshTimer.current), []);

  // 挂载时加载已读位标;加载前 readState={} 天然不亮未读(无位标=从未读过,不误报)。
  // 框架已初始拉取 sessionInfos(initSessionStore 的 loadForCwd),此处不再 reload 列表。
  useEffect(() => {
    void Promise.all([
      ctx.config.get<Record<string, string>>("readState"),
      ctx.config.get<Record<string, string[]>>("customOrder"),
    ]).then(([rs, co]) => {
      const v = rs ?? {};
      readStateRef.current = v;
      setReadState(v);
      readLoadedRef.current = true;
      const co_v = co ?? {};
      customOrderRef.current = co_v;
      setCustomOrder(co_v);
      customOrderLoadedRef.current = true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 已读位标推进到指定 entry;无变化不写盘。fire-and-forget(config.set 有写队列串行化)。 */
  const markRead = (path: string, entryId: string): void => {
    if (!readLoadedRef.current) return;
    const cur = readStateRef.current;
    if (cur[path] === entryId) return;
    const next = { ...cur, [path]: entryId };
    readStateRef.current = next;
    setReadState(next);
    persist("readState", next);
  };

  /** 阶段推进(advancePhase 增量;functional update 保最新 prev,事件闭包不 stale)。 */
  const setPhase = (path: string, event: Parameters<typeof advancePhase>[1]): void => {
    setPhaseByPath((prev) => {
      const next = advancePhase(prev[path] ?? "idle", event);
      return prev[path] === next ? prev : { ...prev, [path]: next };
    });
  };
  /** 运维流 sessionKey(= proc.key)→ 作用域 key(§kernel-forkless §32):算法出自圆心
   *  scopeKeyFromSessionKey(设计 docs/design/session-scope.md §2.2.2),查表注入 sessionInfos。
   *  此前这是本插件的私有实现,goal 的后台归账需要同一个转换却拿不到,于是拿 proc.key
   *  直接比投影路径——fork 过的会话(rekeyProc 后 key≠path)被误判成后台会话,round 双跳。 */
  const nsForSessionKey = (sessionKey: string): string =>
    scopeKeyFromSessionKey(sessionKey, (k) => useSessionStore.getState().sessionInfos?.[k]?.neutralSessionId);
  /** 最新条目记录(entryAppended 权威 id;messageEnd 兜底)。 */
  const recordEntry = (path: string, entryId: string | undefined): void => {
    if (!entryId) return;
    setLastEntryByPath((prev) => (prev[path] === entryId ? prev : { ...prev, [path]: entryId }));
  };

  /** 活跃会话标题水合(权威层在 openSession 用 detail 设;列表事件更新——后台改名——时
   *  这里从 sessionInfos 派生同步,保证 title 跟得上列表的最新值)。 */
  const syncTitleFromList = (list: SessionInfo[]): void => {
    const activeNs = useUiStore.getState().currentNeutralSessionId;
    if (!activeNs) return;
    const active = list.find((s) => s.neutralSessionId === activeNs);
    if (active) useUiStore.getState().setSessionTitle(deriveSessionTitle(active));
  };
  // 列表变化(框架维护)时同步活跃会话标题——收编后不再有 applyList/reload。
  useEffect(() => {
    syncTitleFromList(sessions);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionInfos]);

  /** 手动刷新(用户点刷新按钮):走框架 re-pull 入口(设计 §4.2 手动刷新语义保留)。 */
  const refreshList = async (): Promise<void> => {
    if (!currentCwd) return;
    await useSessionStore.getState().loadSessionInfos(currentCwd);
  };

  const refresh = async (): Promise<void> => {
    if (refreshState !== "idle") return;
    setRefreshState("refreshing");
    try {
      await Promise.all([
        refreshList(),
        new Promise((r) => setTimeout(r, 400)),
      ]);
      setRefreshState("refreshed");
      refreshTimer.current = setTimeout(() => setRefreshState("idle"), 800);
    } catch {
      setRefreshState("idle");
    }
  };

  // 列表数据由框架统一维护(initSessionStore:切 cwd 拉基线 + kernel 事件流增量触发)。
  // 本插件不再自己 ctx.sessions.list,也不再监听列表变更重拉——phase/未读走下方订阅。

  // 列表刷新走运维流(onKernelEvent):全量会话、带 sessionKey 归属——任何会话(后台含)
  // 的 sessionStart(新文件)/messageStart(自动命名落 session_info)/messageEnd(定稿)/
  // agentSettled 都可能改变本目录列表。不能用 sessions.onEvent:那只含激活会话(视图流)。
  // 同一订阅顺手维护两件事(设计 docs/design/session-working-phase.md §2.2/§3.2):
  //  ① 阶段:非流式增量事件(含后台,白名单扩展后)喂 advancePhase;processExit/rpcError 兜底归 idle;
  //  ② 未读增量:entryAppended 权威更新 lastEntry,活跃会话同时推进位标(打开着=已读);
  //     messageEnd 兜底第二来源。位标推进在消息到达时刻,与列表 reload 解耦。
  useEffect(() => {
    return ctx.sessions.onKernelEvent((event) => {
      if (event.kind === "processExit" || event.kind === "rpcError") {
        setPhaseByPath((prev) => (prev[nsForSessionKey(event.sessionKey)] === "idle" ? prev : { ...prev, [nsForSessionKey(event.sessionKey)]: "idle" }));
        return;
      }
      if (event.kind !== "session") return;
      const t = event.event.type;
      setPhase(nsForSessionKey(event.sessionKey), event.event);
      if (t === "entryAppended") {
        const entry = (event.event as { entry?: { id?: unknown } }).entry;
        const entryId = typeof entry?.id === "string" ? entry.id : undefined;
        recordEntry(nsForSessionKey(event.sessionKey), entryId);
        const activePath = useUiStore.getState().currentSessionPath;
        const activeNs = useUiStore.getState().currentNeutralSessionId;
        if (activePath === event.sessionKey && activeNs && entryId) markRead(activeNs, entryId);
      } else if (t === "messageEnd") {
        // 第二来源兜底:部分落盘路径可能跳过 entryAppended(如自定义消息)。
        const msg = (event.event as { message?: { id?: unknown } }).message;
        recordEntry(nsForSessionKey(event.sessionKey), typeof msg?.id === "string" ? msg.id : undefined);
      }
      if (!currentCwd) return;
      // 列表重拉已收编框架(initSessionStore 的 onKernelEvent 订阅),这里只维护 phase/未读。
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentCwd]);

  const newSession = async (): Promise<void> => {
    // 会话上下文三连(path/ns/title)已收进 startNewChat 自身——同一序列此前在本插件与
    // projects/⌘N 各写一遍,漏一个就留残影(§3.3 框架管通用,调用方只传参数)。
    await useSessionStore.getState().startNewChat(currentCwd);
  };

  /** 解析会话可打开的原始文件地址。不再把 SessionInfo.path(投影地址)当文件路径直接打开:
   *  投影地址是坐标系,不承诺磁盘上有文件(迁移前旧 pi 会话无投影、dsh 投影是裸主键)——
   *  原始文件位置是内核专属知识,经服务端 catalog.rawFilePath 解析(§7.6 不硬猜)。 */
  const fetchRawPaths = useCallback(async (s: SessionInfo): Promise<SessionRawFilePaths> => {
    try {
      return await ctx.sessions.rawFilePaths(s.neutralSessionId ?? s.path);
    } catch (err) {
      console.error("[sessions-list] 解析原始文件路径失败:", err);
      return { desktop: null, kernel: null };
    }
  }, [ctx]);

  /** 打开原始文件;无路径/打开失败都显式通知,不静默(此前 shell.openPath 失败被宿主
   *  console.warn 吞掉、插件侧 `void` 丢弃结果——点了没反应也没报错的根因)。
   *
   *  ⚠ r191 更正反馈通道：此前两个分支**只**用 `ctx.notify.show`（系统通知），
   *  而系统通知是**宿主相关**的——`src/server/controllers/notification.ts` 的头注写明
   *  "remote 连接 host 为缺省降级(no-op/不支持)"，node-host 的 notify 就是 no-op。
   *  也就是说：**远程访问 / 纯 Node 宿主下，用户点了"打开原始文件"失败后什么都收不到**
   *  （不是缺 .catch——no-op 是 resolve 而不是 reject，所以 .catch 根本不会触发）。
   *  按 §1.5 的三条出路，这属于"宿主缺面"⇒ 走**显式降级**：改用**应用内**播报
   *  （announceTransient 走常驻 live region，恒可用、且读屏可达），
   *  系统通知保留为**补充**（应用在后台时它才有额外价值）。
   *  这与 r83 的结论一致：反馈通道要选"恒可用的那个"，不能选"宿主可能没有的那个"。 */
  const openRawFile = useCallback(async (path: string | null): Promise<void> => {
    if (!path) {
      announceTransient(t("sessions.noRawFile"), "error");
      void ctx.notify.show({ title: t("sessions.openRaw"), body: t("sessions.noRawFile") });
      return;
    }
    try {
      await ctx.dialog.openFile(path);
    } catch (err) {
      console.error("[sessions-list] 打开原始文件失败:", err);
      announceTransient(t("sessions.openFailed"), "error");
      void ctx.notify.show({ title: t("sessions.openRaw"), body: t("sessions.openFailed") });
    }
  }, [ctx, t]);

  const select = async (s: SessionInfo): Promise<void> => {
    // 乐观设置(勿删,防「高亮等 IPC」退化成体验挂/竞态):点击瞬间同步写 currentSessionPath
    // 拿到即时高亮;main 侧 SessionStore.setContext 会随后 dispatch synthetic sessionStart
    // 权威水合同一字段([见 src/application/sessions/session-store.ts activate 注释])。
    // 乐观层管点击瞬间高亮即时性(async IPC 事件有毫秒级差,不能等);
    // 权威层管最终一致性(main 真相源推 synthetic sessionStart,见 src/application/sessions/
    // session-store.ts / packages/react/src/session-store.ts sendText 注释)。勿删本行。
    // 先记旧值:openSession 失败时回滚选中态,不留“指向打不开会话”的残局
    const { currentSessionPath: prevPath, currentNeutralSessionId: prevNeutral, sessionTitle: prevTitle } = useUiStore.getState();
    setCurrentSessionPath(s.path);
    setCurrentNeutralSessionId(s.neutralSessionId ?? null);
    setSessionTitle(deriveSessionTitle(s));
    try {
      const ok = await useSessionStore.getState().openSession(s.neutralSessionId ?? s.path);
      if (!ok) {
        setCurrentSessionPath(prevPath);
        setCurrentNeutralSessionId(prevNeutral);
        setSessionTitle(prevTitle);
      } else {
        // 打开着=已读:位标推进的入口之一(另一入口是活跃会话的 entryAppended 事件,见上)。
        // 事件驱动的推进不等列表 reload,这里只在打开瞬间补一次(历史会话打开后无新事件)。
        if (s.lastEntryId) markRead(s.neutralSessionId ?? s.path, s.lastEntryId);
      }
    } catch (err) {
      console.error("[sessions-list] 打开会话失败:", err);
      // ⚠ r205：这是 r204 说的**最糟那种**——乐观更新 + 静默回滚。
      //   点击瞬间已把会话上下文三连（path/ns/title）改成新会话，失败后下面三行把它们改回去；
      //   若此时不播报，用户看到的是"高亮跳到别的会话 → 又自己跳回来"，没有任何解释
      //   （§7.6：回滚本身就是需要解释的状态变化）。
      announceTransient(
        t("sessions.openFailed", { detail: (err as Error)?.message ?? String(err) }),
        "error",
      );
      setCurrentSessionPath(prevPath);
      setCurrentNeutralSessionId(prevNeutral);
      setSessionTitle(prevTitle);
    }
  };

  /** 写操作失败后的回滚:全量重拉恢复权威真相(成功路径不需要——
      §neutral-storage-split §2.6 起本地补丁即时生效,广播到达是幂等双写)。 */
  const reloadAfterWrite = async (): Promise<void> => {
    const cwd = useUiStore.getState().currentCwd;
    if (cwd) await useSessionStore.getState().loadSessionInfos(cwd);
  };

  /** 批量归档:对一组会话逐个写头行 archived:true(同一目录锁在 withDirLock 里排队串行)。
      成功后本地打补丁(逐行挪入归档组);失败才全量重拉回滚。 */
  const archiveAll = async (items: SessionInfo[]): Promise<void> => {
    // 乐观移除:点击瞬间全部行即刻退场(exit 动画立即播),不等写+重拉的 IPC 往返。
    for (const s of items) markRemoving(s.path);
    try {
      await Promise.all(items.map((s) => ctx.sessions.updateHeader(s.path, { archived: true })));
      useSessionStore.getState().applyHeaderPatch(items.map((s) => s.path), { archived: true });
    } catch (err) {
      console.error("[sessions-list] 批量归档失败:", err);
      // ⚠ r204：此前 catch 里只有 console + 重拉 ⇒ 用户点归档、行经重拉又回来了、
      //   却没有任何解释（§7.6；r203 识别的**第三种形态**：有 catch 有日志有回滚、就是没有可见反馈）。
      announceTransient(
        t("sessions.archiveFailed", { detail: (err as Error)?.message ?? String(err) }),
        "error",   // 显式 error：默认 info ⇒ 不设 role=alert ⇒ 读屏不打断（r202 已钉成守卫）
      );
      // 失败回滚:重拉权威真相(已写成功的部分也要可见)。
      await reloadAfterWrite();
    } finally {
      clearRemoving();
    }
  };

  /** 删除单个会话(真删 JSONL,不可恢复);错误进 console 并重拉回滚。 */
  const deleteOne = async (s: SessionInfo): Promise<void> => {
    markRemoving(s.path);
    try {
      await ctx.sessions.deleteSessions([s.path]);
      useSessionStore.getState().removeSessionRows([s.path]);
    } catch (err) {
      console.error("[sessions-list] 删除会话失败:", err);
      // ⚠ r203：此前 catch 里**只有 console**——用户点删除、行经 reloadAfterWrite 又回来了，
      //   却没有任何解释（§7.6：降级必须可感知）。删除是"真删 JSONL、不可恢复"的破坏性动作，
      //   静默失败的后果是用户以为删掉了、或反复点。播报必须显式 "error"
      //   （announceTransient 默认 info ⇒ 不设 role=alert ⇒ 读屏不打断，r202 已钉成守卫）。
      announceTransient(
        t("sessions.deleteFailed", { detail: (err as Error)?.message ?? String(err) }),
        "error",
      );
      await reloadAfterWrite();   // 仍要重拉：让列表回到磁盘上的真实状态，别显示半截
    } finally {
      clearRemoving();
    }
  };

  /** 一键删除整组(真删 JSONL,不可恢复):剔除当前活跃会话(进程 append 会复活文件)。 */
  const deleteAll = async (items: SessionInfo[]): Promise<void> => {
    const targets = items.filter((s) => s.neutralSessionId !== currentNeutralSessionId).map((s) => s.path);
    if (targets.length === 0) return;
    for (const p of targets) markRemoving(p);
    try {
      await ctx.sessions.deleteSessions(targets);
      useSessionStore.getState().removeSessionRows(targets);
    } catch (err) {
      console.error("[sessions-list] 批量删除失败:", err);
      announceTransient(   // r203：同 deleteOne（批量删除更要播报——用户以为一次删掉了整组）
        t("sessions.deleteAllFailed", { count: targets.length, detail: (err as Error)?.message ?? String(err) }),
        "error",
      );
      await reloadAfterWrite();
    } finally {
      clearRemoving();
    }
  };

  const filtered = filterSessions(sessions, query);

  const groupings = useSessionGroupings();

  const { topLevel, childrenByParent } = useMemo(() => {
    const children: ChildSession[] = [];
    const childPaths = new Set<string>();
    for (const s of filtered) {
      if (!s.custom) continue;
      for (const g of groupings) {
        const parentPath = s.custom[g.parentPathField];
        if (typeof parentPath === "string" && parentPath) {
          // 带上命中分组的声明，供 ChildSessionRow 兑现（图标/子标题）
          children.push({ session: s, parentPath, childIcon: g.childIcon, childLabelKey: g.childLabelKey });
          childPaths.add(s.path);
          break;
        }
      }
    }
    const childrenMap = new Map<string, ChildSession[]>();
    for (const c of children) {
      const list = childrenMap.get(c.parentPath) ?? [];
      list.push(c);
      childrenMap.set(c.parentPath, list);
    }
    return {
      topLevel: filtered.filter((s) => !childPaths.has(s.path)),
      childrenByParent: childrenMap,
    };
  }, [filtered, groupings]);

  // 排序修正:scanner 返回的是 modified 降序,组内按 created 降序保底(创建时间恒定,不跳)。
  // 拖拽出的 customOrder 在 GroupBlock 渲染时再 applyCustomOrder 重排,这里只动默认序。
  const topLevelSorted = useMemo(
    () => [...topLevel].sort((a, b) => b.created.localeCompare(a.created)),
    [topLevel],
  );

  const groups = query
    ? [{ groupId: "search", label: "", items: filtered, kind: "time" as GroupKind, defaultOpen: true }]
    : buildGroups(topLevelSorted);

  // 乐观新建条目(设计 docs/design/optimistic-new-session-entry.md):当前处于「新对话壳」态
  // (currentSessionPath===null 且有 cwd、列表已加载、非搜索态)时,列表顶部渲染一个高亮的
  // 「新对话」占位行。首条消息落盘 → sessionStart 水合 currentSessionPath → 占位消失,
  // 由真实会话条目接管。纯渲染投影:sessionInfos 权威数据源不动。
  const showOptimistic = !loading && !!currentCwd && currentNeutralSessionId === null && !query;

  const setGroupOrder = useCallback((groupId: string, paths: string[]): void => {
    const next = { ...customOrderRef.current, [groupId]: paths };
    customOrderRef.current = next;
    setCustomOrder(next);
  }, []);
  const persistOrder = useCallback((): void => {
    persist("customOrder", customOrderRef.current);
  }, [ctx]);

  return (
    <Section
      title={t("sessions.title")}
      actions={
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => { setSearchOpen((v) => !v); }}
            title={t("sessions.search")}
            data-session-search=""
            aria-label={t("sessions.search")}
            className="flex items-center justify-center size-6 rounded-[var(--radius-sm)] bg-transparent border-none cursor-pointer text-[var(--color-muted)] hover:text-[var(--color-fg)]"
            style={searchOpen ? { color: "var(--color-primary)" } : undefined}
          >
            <Search style={{ width: "var(--sidebar-icon-size)", height: "var(--sidebar-icon-size)" }} />
          </button>
          <button
            onClick={() => void refresh()}
            disabled={refreshState !== "idle"}
            title={t("sessions.refresh")}
            data-session-refresh=""
            aria-label={t("sessions.refresh")}
            className="flex items-center justify-center size-6 rounded-[var(--radius-sm)] bg-transparent border-none cursor-pointer text-[var(--color-muted)] hover:text-[var(--color-fg)] disabled:cursor-default"
          >
            {refreshState === "refreshed" ? (
              <Check className="size-3.5" style={{ color: "var(--color-accent-success)" }} />
            ) : (
              <RotateCw className={`size-3.5 ${refreshState === "refreshing" ? "animate-spin" : ""}`} style={{ width: "var(--sidebar-icon-size)", height: "var(--sidebar-icon-size)" }} />
            )}
          </button>
          {/* data-session-new / -search / -refresh：稳定锚点，e2e 与 DOM 审计据此定位，
              不按译文（六个语言下「新建/搜索/刷新」是六套字符串）。见 skill §17.3。 */}
          <button data-session-new="" onClick={() => void newSession()} title={t("sessions.new")} style={plusBtnStyle} className="shrink-0 hover:text-[var(--color-fg)]">
            <Plus style={{ width: "var(--sidebar-icon-size)", height: "var(--sidebar-icon-size)" }} />
          </button>
        </div>
      }
    >
      {/* 搜索展开框:点搜索图标 toggle,动画展开/收起;挂在标题行下方、列表之上。
          空查询时失焦或 Esc 自动收起;有内容时保持,清空即收。 */}
      <AnimatePresence>
        {searchOpen && (
          <motion.div
            key="search-box"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className="overflow-hidden"
          >
            <div className="flex items-center gap-1.5 px-2 pb-2 pt-1">
              <Search className="size-3.5 shrink-0 text-[var(--color-muted)]" />
              {/* `data-session-search-input` 是**真正的搜索输入框**（仅 searchOpen 时渲染）。
                  ⚠ 别与工具条上那个 `data-session-search` 混淆——后者是**展开/收起搜索**的按钮
                  （`setSearchOpen((v) => !v)`）。首版剧本把锚点加在按钮上就往里打字，
                  于是"搜索没生效"看起来像过滤坏了，其实是输入框根本没被写到。 */}
              <input
                data-session-search-input=""
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Escape") { if (query) setQuery(""); else setSearchOpen(false); } }}
                placeholder={t("sessions.search")}
                className="w-full bg-transparent border-none outline-none text-[length:var(--font-size-base)] text-[var(--color-fg)] placeholder:text-[var(--color-muted)]"
              />
              {query && (
                <button
                  onClick={() => { setQuery(""); }}
                  title={t("sessions.search")}
                  className="shrink-0 text-[var(--color-muted)] hover:text-[var(--color-fg)] bg-transparent border-none cursor-pointer p-0"
                >
                  <X className="size-3.5" />
                </button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      {loading && <div className="px-2.5 py-2 text-[length:var(--font-size-base)] text-[var(--color-muted)]">{t("sessions.loading")}</div>}
      {!loading && !currentCwd && (
        <div className="px-2.5 py-2 text-[length:var(--font-size-base)] text-[var(--color-muted)]">{t("sessions.openFolderFirst")}</div>
      )}
      {!loading && currentCwd && filtered.length === 0 && !showOptimistic && (
        <div className="px-2.5 py-2 text-[length:var(--font-size-base)] text-[var(--color-muted)]">{query ? t("sessions.noMatch") : t("sessions.empty")}</div>
      )}
      <AnimatePresence mode="popLayout">
      {showOptimistic && (
        <motion.div
          key="new-chat"
          layout
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18, ease: "easeOut" }}
          style={{ paddingBottom: "var(--sidebar-row-gap)" }}
        >
          <NewChatRow onClick={() => void newSession()} sessionPath={`new:${currentCwd}`} />
        </motion.div>
      )}
      {groups.map((g) => {
        // 乐观移除的行从渲染树摘除(exit 动画即刻播放);重拉完成后 clearRemoving 恢复权威渲染。
        const orderedItems = applyCustomOrder(g.items, customOrder[g.groupId], (s) => s.neutralSessionId ?? s.path, (s) => s.created)
          .filter((s) => !removing.has(s.path));
        return (
        <GroupBlock
          // key 必须带 cwd(根因修复):分组键 g.kind+g.label 跨项目高度重复(每个项目都有
          // 「今天」组),切项目时 React 复用同一 GroupBlock 实例 + dnd-kit SortableContext/
          // useSortable 的内部状态残留 → 旧项目的 SortableRow 不卸载,列表里两个目录的会话
          // 叠加(观感是「切项目后左侧根本不刷新」)。带 cwd 后切项目即整体重挂,行的身份
          // 与它的归属项目绑定。
          key={`${currentCwd}:${g.kind}${g.label}`}
          group={g}
          orderedItems={orderedItems}
          onReorder={(paths) => setGroupOrder(g.groupId, paths)}
          onEnd={persistOrder}
          onArchiveAll={
            g.kind === "time"
              ? () => void archiveAll(g.items)
              : undefined
          }
          onDeleteAll={
            g.kind === "archive"
              ? () => void deleteAll(g.items)
              : undefined
          }
        >
          {orderedItems.map((s) => (
            <SortableRow key={s.path} path={s.path} dragEnabled={!query && g.kind !== "archive"}>
              <SessionRow
                session={s}
                flat={!!query}
                active={currentNeutralSessionId === s.neutralSessionId}
                snapshotAlive={snapshotAlive && currentNeutralSessionId === s.neutralSessionId}
                phase={phaseByPath[s.neutralSessionId ?? s.path] ?? "idle"}
                unread={
                  currentNeutralSessionId !== s.neutralSessionId &&
                  !!lastEntryByPath[s.neutralSessionId ?? s.path] &&
                  readState[s.neutralSessionId ?? s.path] !== lastEntryByPath[s.neutralSessionId ?? s.path]
                }
                deletable={currentNeutralSessionId !== s.neutralSessionId}
                onDelete={() => deleteOne(s)}
                onClick={() => void select(s)}
                onRawPaths={fetchRawPaths}
                onOpenRawFile={(p) => void openRawFile(p)}
                onUpdate={async (patch) => {
                  // 归档/取消归档:点击瞬间乐观摘行(立即播消失动画),不等写的 IPC 往返。
                  if (patch.archived != null) markRemoving(s.path);
                  try {
                    await ctx.sessions.updateHeader(s.path, patch);
                    // 成功:本地打补丁即时生效(§2.6;广播到达是幂等双写),不再全量重拉。
                    useSessionStore.getState().applyHeaderPatch(s.path, patch);
                    if (patch.name != null && currentNeutralSessionId === s.neutralSessionId) {
                      setSessionTitle(deriveSessionTitle({ ...s, name: patch.name }));
                    }
                  } catch (err) {
                    console.error("[sessions-list] 更新会话头失败:", err);
                    // r204：同批量归档（第三种形态）。更新会话头 = 重命名/置顶/取消置顶/归档单条，
                    //   都是用户刚点的动作；静默回滚会让用户以为改成功了（下次刷新才发现没改）。
                    announceTransient(
                      t("sessions.updateHeaderFailed", { detail: (err as Error)?.message ?? String(err) }),
                      "error",
                    );
                    // 失败回滚:重拉权威真相,乐观摘除不能永久吞行。
                    await reloadAfterWrite();
                  } finally {
                    clearRemoving();
                  }
                }}
                // 搜索平铺态(flat)不嵌套子会话:子会话已在 filtered 里作为独立行出现,
                // 再嵌套会在父、子同命中时重复显示(问题 D10)。非搜索态才按分组嵌套。
                children={query ? undefined : childrenByParent.get(s.path)}
                onSelectChild={(child) => void select(child)}
                onDeleteChild={(child) => deleteOne(child)}
                activeChildPath={currentNeutralSessionId ?? undefined}
                phaseByPath={phaseByPath}
              />
            </SortableRow>
          ))}
        </GroupBlock>
        );
      })}
      </AnimatePresence>
    </Section>
  );
}

const SortableRow = forwardRef<HTMLDivElement, { path: string; dragEnabled: boolean; children: React.ReactElement }>(function SortableRow({ path, dragEnabled, children }, ref): React.ReactNode {
  const { t } = useTranslation();
  return (
    <SortableList.Item
      ref={ref}
      value={path}
      disabled={!dragEnabled}
      title={dragEnabled ? String(t("shell.dragToReorder")) : undefined}
      style={{ paddingBottom: "var(--sidebar-row-gap)" }}
    >
      {children}
    </SortableList.Item>
  );
});

/** 分组:pinned 在最上 → 时间四档 → archive 在最下(归档不进时间分组)。
 *  label 存 i18n key(GroupBlock 渲染时 t(label)),buildGroups 是纯数据不依赖 t。
 *  groupId 是持久化 customOrder 的稳定 key(label→groupId 映射后写进 Group)。 */
const LABEL_TO_GROUP_ID: Record<string, string> = {
  "sessions.pinned": "pinned",
  "sessions.today": "today",
  "sessions.yesterday": "yesterday",
  "sessions.last7days": "last7days",
  "sessions.earlier": "earlier",
  "sessions.archived": "archived",
};
function buildGroups(items: SessionInfo[]): Group[] {
  const pinned = items.filter((s) => s.pinned && !s.archived);
  const archived = items.filter((s) => s.archived);
  const rest = items.filter((s) => !s.pinned && !s.archived);
  const byTime = groupByTime(rest);
  const groups: Group[] = [];
  if (pinned.length) groups.push({ groupId: "pinned", label: "sessions.pinned", items: pinned, kind: "pinned", defaultOpen: true });
  for (const g of byTime) groups.push({ groupId: LABEL_TO_GROUP_ID[g.label] ?? g.label, label: g.label, items: g.items, kind: "time", defaultOpen: true });
  if (archived.length) groups.push({ groupId: "archived", label: "sessions.archived", items: archived, kind: "archive", defaultOpen: false });
  return groups;
}

/** 按创建时间分组:今天 / 昨天 / 过去 7 天 / 更早(各组内保持 mtime 降序)。label 存 i18n key。 */
function groupByTime(items: SessionInfo[]): { label: string; items: SessionInfo[] }[] {
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const today = dayStart.getTime();
  const yesterday = today - 86400000;
  const week = today - 7 * 86400000;
  const buckets: { label: string; items: SessionInfo[]; min: number }[] = [
    { label: "sessions.today", items: [], min: today },
    { label: "sessions.yesterday", items: [], min: yesterday },
    { label: "sessions.last7days", items: [], min: week },
    { label: "sessions.earlier", items: [], min: -Infinity },
  ];
  for (const s of items) {
    const t = new Date(s.created).getTime();
    buckets.find((b) => t >= b.min)?.items.push(s);
  }
  return buckets.filter((b) => b.items.length > 0);
}

/** 分组容器:有 label 才画折叠头(搜索平铺时 kind=time 但 label 为空 → 不画头)。
 *  复用 index.css 的 .shell-collapsible 动画(与 Section 同一套)。
 *  time 分组折叠头右侧带"批量归档"(hover 显示),把整组会话标 archived。 */
const GroupBlock = forwardRef<HTMLDivElement, {
  group: Group;
  orderedItems: SessionInfo[];
  onReorder: (paths: string[]) => void;
  onEnd?: () => void;
  children: React.ReactNode;
  onArchiveAll?: () => void;
  onDeleteAll?: () => void;
}>(function GroupBlock({ group, orderedItems, onReorder, onEnd, children, onArchiveAll, onDeleteAll }, ref): React.ReactNode {
  const { t } = useTranslation();
  const [open, setOpen] = useState(group.defaultOpen ?? true);
  const [hovered, setHovered] = useState(false);
  const [armed, setArmed] = useState(false);
  const ids = useMemo(() => orderedItems.map((s) => s.neutralSessionId ?? s.path), [orderedItems]);
  const list = (
    <SortableList values={ids} onReorder={onReorder} onEnd={onEnd} className="flex flex-col">
      <AnimatePresence mode="popLayout">{children}</AnimatePresence>
    </SortableList>
  );
  // 无标题的分组（当前只有搜索态：`{ groupId: "search", label: "" }`）走这条早退分支——
  // 它没有折叠头，所以没有 open 态。⚠ **锚点必须两条分支都带**：首版只给下面那条带标题的
  // 分支加了 `data-session-group`，于是搜索态查出来是 0 个分组元素，而"每个分组都是 search"
  // 那条断言在**空数组上恒真**、假绿通过（`[].every(...)` === true）。
  if (!group.label) {
    return (
      <motion.div ref={ref} layout className="flex flex-col" data-session-group={group.groupId} data-session-group-open="true">
        {list}
      </motion.div>
    );
  }
  return (
    // `data-session-group` = 稳定分组 id（pinned/today/yesterday/last7days/earlier/archived/search），
    // 它同时是持久化 customOrder 的 key。e2e 与 DOM 审计据此判断"某行属于哪个分组"，
    // 不按分组标题的译文（六种语言六套字符串）。`-open` 标出折叠态：archived 组默认折叠，
    // 断言"行移进了归档组"时要连折叠态一起读，否则会把"折叠了看不见"误判成"没有这一行"。
    <motion.div ref={ref} layout className="flex flex-col" data-session-group={group.groupId} data-session-group-open={open ? "true" : "false"}>
      <div
        className="flex items-center pr-2.5"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => { setHovered(false); setArmed(false); }}
      >
        <button
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="flex flex-1 min-w-0 items-center gap-1.5 text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)] bg-transparent border-none cursor-pointer text-left"
          style={{ outline: "none", paddingLeft: "10px", paddingTop: "10px", paddingBottom: "14px" }}
        >
          {group.kind === "pinned" && <Pin className="size-3" />}
          {group.kind === "archive" && <Archive className="size-3" />}
          <span>{t(group.label)}</span>
        </button>
        {group.kind === "time" && onArchiveAll && (
          <button
            onClick={(e) => { e.stopPropagation(); onArchiveAll(); }}
            title={t("sessions.archiveAllTitle")}
            className="ml-auto flex items-center gap-1 text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)] bg-transparent border-none cursor-pointer px-1.5 py-0.5 rounded-[var(--radius-sm)]"
            style={{ outline: "none", opacity: hovered ? 1 : 0, pointerEvents: hovered ? "auto" : "none", transition: "opacity 0.15s ease" }}
          >
            <Archive className="size-3" /> {t("sessions.archiveAll")}
          </button>
        )}
        {group.kind === "archive" && onDeleteAll && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (!armed) { setArmed(true); return; }
              setArmed(false);
              onDeleteAll();
            }}
            title={t("sessions.deleteAllTitle")}
            className="ml-auto flex items-center gap-1 text-xs bg-transparent border-none cursor-pointer px-1.5 py-0.5 rounded-[var(--radius-sm)]"
            style={{ outline: "none", opacity: hovered ? 1 : 0, pointerEvents: hovered ? "auto" : "none", transition: "opacity 0.15s ease", color: armed ? "var(--color-accent-danger)" : "var(--color-muted)" }}
          >
            <Trash2 className="size-3" /> {armed ? t("sessions.deleteAllConfirm", { count: group.items.length }) : t("sessions.deleteAll")}
          </button>
        )}
      </div>
      <div className="shell-collapsible" data-state={open ? "open" : "closed"}>
        {list}
      </div>
    </motion.div>
  );
});

function SessionRow({ session, flat, active, snapshotAlive, phase, unread, deletable, onClick, onRawPaths, onOpenRawFile, onDelete, onUpdate, children: childSessions, onSelectChild, onDeleteChild, activeChildPath, phaseByPath }: {
  session: SessionInfo;
  flat: boolean;
  active: boolean;
  snapshotAlive: boolean;
  phase: WorkingPhase;
  unread: boolean;
  deletable?: boolean;
  onClick: () => void;
  /** 解析某会话可打开的原始文件地址(desktop 中立层文件 + 内核原始文件)。 */
  onRawPaths: (s: SessionInfo) => Promise<SessionRawFilePaths>;
  /** 打开原始文件;入参 null = 无文件可开,由实现侧显式降级通知(不静默)。 */
  onOpenRawFile: (path: string | null) => void;
  onDelete?: () => Promise<void>;
  onUpdate: (patch: HeaderPatch) => Promise<void>;
  children?: ChildSession[];
  onSelectChild?: (s: SessionInfo) => void;
  onDeleteChild?: (s: SessionInfo) => Promise<void>;
  activeChildPath?: string;
  phaseByPath?: Record<string, WorkingPhase>;
}): React.ReactNode {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [childrenExpanded, setChildrenExpanded] = useState(false);
  // 「打开原始文件」下拉(两项:desktop 中立层文件 / 内核原始文件)。菜单打开期间强制保留
  // hover 操作区:弹层经 Portal 渲染在行外,鼠标移入弹层会触发行的 mouseLeave,
  // 若操作区随 hovered 收起,DropdownMenu.Root 被卸载,菜单秒关(根因:渲染条件耦合 hover)。
  const [rawMenuOpen, setRawMenuOpen] = useState(false);
  const [rawPaths, setRawPaths] = useState<SessionRawFilePaths | null>(null);
  // 标题:deriveSessionTitle(展示层唯一来源:name → lastMessage 预览 → id 前 8 位)。
  // 未命名会话不再退化成 id 前缀,回落到最后一条消息预览(问题 B)。
  const title = deriveSessionTitle(session);
  const sub = session.lastMessage ?? new Date(session.created).toLocaleString();
  // 行状态 → 可访问文本。
  //
  // ⚠ 为什么需要：这一行的可访问名原本**只有标题**。而"置顶""归档""正在思考/执行工具/重试"
  //   这些状态全部只靠图标形态与颜色表达（Pin / Archive / PhaseIcon 的六种形状与配色）——
  //   读屏用户能听到"排序甲"，听不到"已置顶、思考中"。这不是"缺可访问名"（r38 的普查查不出来，
  //   因为行**有**名字），而是"名字**不够用**"：视觉信息与可访问信息不对等。
  //   修法是补一段**视觉隐藏**的状态文本进可访问名，而不是去给图标加 aria-label
  //   （图标是装饰性的，语义应该由文本承担；给每个图标加名字反而会让读屏念出一串碎片）。
  //
  // 阶段文案**复用 shell.* 既有键**（timeline 底部指示器用的同一套），不另造一份：
  //   §1.3 契约单源。其中 `shell.retrying` 此前四个语言都缺 —— timeline 有意不用它
  //   （重试态由重试横幅承担，见 index.tsx:99 的注释），但会话行的图标确实画了 retrying
  //   的红色转圈，所以本轮把该键补进 shell 命名空间（timeline 不受影响）。
  // ⚠ 未读与「内核未装载」也走这里，而不是靠各自徽标上的 aria-label：
  //   ① 那两个徽标是**无 role 的 `<span>`**（只含一个 svg），`aria-label` 挂在 generic 元素上
  //     按 ARIA 不被可靠暴露；靠 `title` 兜底又很脆（title 同时是悬浮提示，且部分
  //     读屏/浏览器组合不会把后代的 title 并入父级可访问名）。
  //   ② 未读圆点的渲染条件是 `unread && !hovered` —— **hover 时徽标整个从 DOM 消失**，
  //     状态跟着消失。放进常驻的 sr-only 文本后不再依赖 hover。
  //   徽标本身保留（视觉锚 + title 悬浮给明眼人），但标 aria-hidden 避免重复播报。
  const stateText = [
    session.pinned ? t("sessions.pinned") : null,
    session.archived ? t("sessions.archived") : null,
    phase !== "idle" ? t(PHASE_LABEL_KEY[phase] ?? "") : null,
    unread ? t("sessions.unread") : null,
    session.kernelLoaded === false
      ? t("sessions.kernelNotLoadedShort", { kernel: session.kernel ?? "" })
      : null,
  ].filter((x): x is string => !!x && !x.startsWith("shell."));
  // 行图标:正常行与重命名编辑行共用(编辑行与正常行同构,见下)。
  // 阶段图标按 WorkingPhase 切换形态与颜色(设计 docs/design/session-working-phase.md §2.3):
  // 请求=转圈(灰)/思考=脑(蓝紫)/工具=扳手(绿)/输出=转圈(蓝)/重试·压缩=转圈(红/灰);
  // idle 回落到 snapshotAlive 区分的 MessageSquare(实心=活会话进程,空心=无进程)。
  const rowIcon = session.pinned
    ? <Pin className="text-[var(--color-primary)]" style={{ width: "var(--sidebar-icon-size)", height: "var(--sidebar-icon-size)" }} />
    : phase !== "idle"
    ? <PhaseIcon phase={phase} />
    : snapshotAlive
    ? <MessageSquare className="text-[var(--color-primary)]" fill="currentColor" style={{ width: "var(--sidebar-icon-size)", height: "var(--sidebar-icon-size)" }} />
    : <MessageSquare className="text-[var(--color-muted)]" style={{ width: "var(--sidebar-icon-size)", height: "var(--sidebar-icon-size)" }} />;

  if (confirmingDelete) {
    return (
      <div
        className="flex items-center gap-2 px-2.5 py-2 rounded-[var(--radius-sm)]"
        style={{ border: "1px solid var(--color-accent-danger)", color: "var(--color-accent-danger)" }}
      >
        <Trash2 className="size-4 shrink-0" />
        <span className="flex-1 text-[length:var(--font-size-base)]">{t("sessions.deleteConfirm")}</span>
        <button
          onClick={() => { setConfirmingDelete(false); void onDelete?.(); }}
          title={t("sessions.deleteConfirmYes")}
          className="flex items-center justify-center size-6 rounded-[var(--radius-sm)] bg-transparent border-none cursor-pointer hover:text-[var(--color-fg)]"
          style={{ color: "var(--color-accent-danger)" }}
        >
          <Check className="size-4" />
        </button>
        <button
          onClick={() => setConfirmingDelete(false)}
          title={t("sessions.deleteConfirmNo")}
          className="flex items-center justify-center size-6 rounded-[var(--radius-sm)] bg-transparent border-none cursor-pointer text-[var(--color-muted)] hover:text-[var(--color-fg)]"
        >
          <X className="size-4" />
        </button>
      </div>
    );
  }

  if (editing) {
    // 与正常行逐像素同构(同 padding/border/radius + 图标盒 + 标题位 input + 副标题),
    // 进出编辑态零跳动。编辑态提示用 input 的 box-shadow 下划线(inset 不占布局高度),
    // 不用 border——card 风格外行 border 是 1px,裸加边框会把行撑高 2px。
    // input 是 replaced element,font-family 不继承,需显式 inherit 对齐标题字体。
    return (
      <div
        className="flex items-center gap-2 select-none whitespace-nowrap"
        style={{
          padding: "var(--sidebar-row-py) var(--sidebar-row-px)",
          background: active ? "var(--sidebar-row-bg-active)" : "var(--sidebar-row-bg)",
          border: active ? "var(--sidebar-row-border-active)" : "var(--sidebar-row-border)",
          borderRadius: "var(--sidebar-row-radius)",
          boxShadow: active ? "var(--sidebar-row-shadow-active)" : "var(--sidebar-row-shadow)",
        }}
      >
        <div className="shrink-0 flex items-center justify-center" style={{ width: "var(--sidebar-icon-box)", height: "var(--sidebar-icon-box)" }}>
          {rowIcon}
        </div>
        <div className="flex-1 min-w-0">
          {/* data-session-rename：重命名态的输入框锚点。它**不一定**是 [data-session-path]
              的后代（SessionRow 与 ContextMenu.Trigger 是两层），所以 e2e 不能靠
              "[data-session-path] input" 这种层级猜测定位——给个稳定锚点。 */}
          <input
            data-session-rename=""
            autoFocus
            defaultValue={session.name ?? ""}
            placeholder={session.id.slice(0, 8)}
            onKeyDown={async (e) => {
              if (e.key === "Enter") {
                const v = (e.target as HTMLInputElement).value.trim();
                setEditing(false);
                if (v !== (session.name ?? "")) await onUpdate({ name: v });
              } else if (e.key === "Escape") {
                setEditing(false);
              }
            }}
            onBlur={() => setEditing(false)}
            // block:input 默认 inline-level,匿名行框的 strut 会把编辑行撑高 ~5px(相对正常行)。
            // pointerdown stopPropagation:整行是 Reorder.Item 拖拽区,不阻断冒泡则 input 里
            // 选文本的手势被行拖拽抢走(体感「rename 被拖动覆盖」)。
            onPointerDown={(e) => e.stopPropagation()}
            className="block w-full p-0 border-none bg-transparent outline-none text-[length:var(--font-size-lg)] font-semibold leading-tight text-[var(--color-fg)] placeholder:text-[var(--color-muted)]"
            style={{ fontFamily: "inherit", boxShadow: "inset 0 -1px 0 0 var(--color-primary)" }}
          />
          <div className="truncate text-[length:var(--font-size-sm)] leading-tight text-[var(--color-muted)] mt-0.5">{sub}</div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div
          data-session-path={session.path}
          // 当前会话此前只靠 background/border/boxShadow 三个 token 表达（视觉态有、可访问态无），
          // 读屏用户在会话列表里听不出自己正处在哪一个会话。与 r36 给项目行补 aria-current 同类。
          // ⚠ 非激活时给 undefined 而不是 "false"：aria-current="false" 会出现在每一行上，
          //   等于给全部行都挂一个状态属性（部分读屏会念出来），语义反而是噪音。
          aria-current={active ? "true" : undefined}
          onClick={onClick}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          className="flex items-center gap-2 cursor-pointer select-none whitespace-nowrap"
          style={{
            padding: "var(--sidebar-row-py) var(--sidebar-row-px)",
            background: active ? "var(--sidebar-row-bg-active)" : hovered ? "var(--sidebar-row-bg-hover)" : "var(--sidebar-row-bg)",
            border: active ? "var(--sidebar-row-border-active)" : hovered ? "var(--sidebar-row-border-hover)" : "var(--sidebar-row-border)",
            borderRadius: "var(--sidebar-row-radius)",
            boxShadow: active ? "var(--sidebar-row-shadow-active)" : "var(--sidebar-row-shadow)",
            color: active ? "var(--color-fg)" : "var(--color-muted)",
            transition: "background 0.12s, border-color 0.12s, box-shadow 0.12s",
          }}
        >
          <div className="shrink-0 flex items-center justify-center" style={{ width: "var(--sidebar-icon-box)", height: "var(--sidebar-icon-box)" }}>
            {rowIcon}
          </div>
          <div className="flex-1 min-w-0">
            <div className="truncate text-[length:var(--font-size-lg)] font-semibold leading-tight text-[var(--color-fg)]">{title}</div>
            {/* 视觉隐藏的状态文本：进可访问名，让读屏听到"已置顶、思考中"这类只靠图标表达的状态。
                ⚠ 用 Tailwind 的 sr-only（不是自造样式）。本仓有过 @source 扫描漂移的历史
                （CLAUDE.md §3.7），所以 a11y-names-audit 里有一条断言专门验证它**真的**
                产生了视觉隐藏的计算样式（1px 宽高 + clip），类没生成就会红。 */}
            {stateText.length > 0 && (
              <span className="sr-only" data-session-state-text="">{stateText.join("，")}</span>
            )}
            <div className="truncate text-[length:var(--font-size-sm)] leading-tight text-[var(--color-muted)] mt-0.5">{sub}</div>
          </div>
          {/* 搜索平铺时,归档项给个 Archive 角标提示 */}
          {flat && session.archived && (
            // 装饰性图标：归档状态已由上面的视觉隐藏文本承担，这里标 aria-hidden
            // 避免读屏重复播报（或把一个无名 svg 念成噪音）。
            <Archive aria-hidden="true" className="size-3.5 shrink-0 text-[var(--color-muted)]" />
          )}
          {/* 内核未装载角标(§7.6 显式降级):这一行仍可读(内容在中立层),但发不出去、派不生。
              此前这种行在侧栏和正常行长得一模一样,点下去只往 console 写一条「未注册的内核」——
              用户看到的是"点了没反应",而且它当时还删不掉(服务端删内核文件那步抛错)。
              角标 + tooltip 说明能做什么、要怎么恢复;可读性由 timeline 的只读条承接。 */}
          {session.kernelLoaded === false && (
            <span
              data-session-kernel-unloaded="true"
              title={t("sessions.kernelNotLoaded", { kernel: session.kernel ?? "" })}
              // 状态语义已由行内 sr-only 文本承担（见 stateText 的说明）；
              // 这里标 aria-hidden 避免重复播报，title 保留给明眼人做悬浮解释。
              aria-hidden="true"
              className="shrink-0 flex items-center justify-center text-[var(--color-muted)]"
            >
              <TriangleAlert className="size-3.5" />
            </span>
          )}
          {/* 未读圆点:hover 时让位给操作区(行宽有限,操作语义优先于状态提示) */}
          {unread && !hovered && !childSessions?.length && (
            <span
              title={t("sessions.unread")}
              aria-hidden="true"
              className="size-2 shrink-0 rounded-full bg-[var(--color-primary)]"
            />
          )}
          {childSessions && childSessions.length > 0 && (
            <button
              onClick={(e) => { e.stopPropagation(); setChildrenExpanded((v) => !v); }}
              title={childrenExpanded ? t("shell.collapse") : t("shell.expand")}
              className="flex items-center justify-center size-5 shrink-0 rounded-[var(--radius-sm)] bg-transparent border-none cursor-pointer text-[var(--color-muted)] hover:text-[var(--color-fg)]"
            >
              {childrenExpanded
                ? <ChevronDown className="size-3.5" />
                : <ChevronRight className="size-3.5" />}
            </button>
          )}
          {/* hover 操作区:置顶/归档/打开原始文件( hover 或原始文件菜单打开时才现;
              stopPropagation 不点穿行选中)。「打开原始文件」是下拉:desktop 中立层文件 /
              内核原始文件两项——投影地址≠文件路径,真实地址经服务端按内核解析(§7.6)。 */}
          {(hovered || rawMenuOpen) && (
            <div className="flex items-center gap-1 shrink-0 flex-nowrap">
              <button
                onClick={(e) => { e.stopPropagation(); void onUpdate({ pinned: !session.pinned }); }}
                title={session.pinned ? t("sessions.unpin") : t("sessions.pin")}
                className="flex items-center justify-center size-6 rounded-[var(--radius-sm)] bg-transparent border-none cursor-pointer text-[var(--color-muted)] hover:text-[var(--color-fg)]"
                style={session.pinned ? { color: "var(--color-primary)" } : undefined}
              >
                {session.pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); void onUpdate({ archived: !session.archived }); }}
                title={session.archived ? t("sessions.unarchive") : t("sessions.archive")}
                className="flex items-center justify-center size-6 rounded-[var(--radius-sm)] bg-transparent border-none cursor-pointer text-[var(--color-muted)] hover:text-[var(--color-fg)]"
                style={session.archived ? { color: "var(--color-primary)" } : undefined}
              >
                {session.archived ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />}
              </button>
              <DropdownMenu.Root
                onOpenChange={(open) => {
                  setRawMenuOpen(open);
                  if (open) {
                    setRawPaths(null);
                    void onRawPaths(session).then(setRawPaths);
                  }
                }}
              >
                <DropdownMenu.Trigger asChild>
                  <button
                    onClick={(e) => e.stopPropagation()}
                    title={t("sessions.openRaw")}
                    aria-label={t("sessions.openRaw")}
                    className="flex items-center justify-center size-6 rounded-[var(--radius-sm)] bg-transparent border-none cursor-pointer text-[var(--color-muted)] hover:text-[var(--color-fg)]"
                  >
                    <FileJson className="size-4" />
                  </button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content style={ctxMenuStyle} sideOffset={4} align="end">
                    {/* 解析中(rawPaths=null)禁点;解析完某项为 null 仍可点——点了走显式降级通知 */}
                    <DropdownMenu.Item
                      disabled={rawPaths === null}
                      onSelect={() => onOpenRawFile(rawPaths?.desktop ?? null)}
                      style={ctxItemStyle}
                    >
                      <AppWindow className="size-3.5" /> {t("sessions.openDesktopFile")}
                    </DropdownMenu.Item>
                    <DropdownMenu.Item
                      disabled={rawPaths === null}
                      onSelect={() => onOpenRawFile(rawPaths?.kernel ?? null)}
                      style={ctxItemStyle}
                    >
                      <FileJson className="size-3.5" /> {t("sessions.openKernelFile")}
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            </div>
          )}
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content style={ctxMenuStyle}>
          {/* `data-session-action` 是稳定锚点：e2e 与 DOM 审计据此定位菜单项，
              **不按译文文案匹配**（六种语言下「重命名」是六个不同字符串，按文案找等于
              把测试绑死在某一种语言上，见 skill §17.3）。值是动作语义、与语言无关。 */}
          <ContextMenu.Item data-session-action="rename" onSelect={() => setEditing(true)} style={ctxItemStyle}>
            <Pencil className="size-3.5" /> {t("sessions.rename")}
          </ContextMenu.Item>
          <ContextMenu.Item
            data-session-action="pin"
            onSelect={() => void onUpdate({ pinned: !session.pinned })}
            style={ctxItemStyle}
          >
            <Pin className="size-3.5" /> {session.pinned ? t("sessions.unpin") : t("sessions.pin")}
          </ContextMenu.Item>
          <ContextMenu.Item
            data-session-action="archive"
            onSelect={() => void onUpdate({ archived: !session.archived })}
            style={ctxItemStyle}
          >
            <Archive className="size-3.5" /> {session.archived ? t("sessions.unarchive") : t("sessions.archive")}
          </ContextMenu.Item>
          {/* 打开原始文件拆两项:中立层文件 / 内核文件(选择时懒解析,缺面显式降级通知) */}
          <ContextMenu.Item
            data-session-action="open-desktop-file"
            onSelect={() => void onRawPaths(session).then((p) => onOpenRawFile(p.desktop))}
            style={ctxItemStyle}
          >
            <AppWindow className="size-3.5" /> {t("sessions.openDesktopFile")}
          </ContextMenu.Item>
          <ContextMenu.Item
            data-session-action="open-kernel-file"
            onSelect={() => void onRawPaths(session).then((p) => onOpenRawFile(p.kernel))}
            style={ctxItemStyle}
          >
            <FileJson className="size-3.5" /> {t("sessions.openKernelFile")}
          </ContextMenu.Item>
          {/* 删除:不可恢复,仅 deletable(非当前活跃会话);点后进整行内联确认态,不直接删 */}
          {deletable && onDelete && (
            <ContextMenu.Item data-session-action="delete" onSelect={() => setConfirmingDelete(true)} style={{ ...ctxItemStyle, color: "var(--color-accent-danger)" }}>
              <Trash2 className="size-3.5" /> {t("sessions.delete")}
            </ContextMenu.Item>
          )}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
    {childSessions && childSessions.length > 0 && (
      <div className="shell-collapsible" data-state={childrenExpanded ? "open" : "closed"}>
        <div className="flex flex-col">
          {/* 契约 childLabelKey：分组策略可声明"缩进组标题"；不提供则不显（不编一个默认标题）。
              取第一个子行的声明即可——同一父会话下的子行必然命中同一个分组策略
              （上面的循环对每个 session 只 break 出第一个命中的 g）。 */}
          {childSessions[0]?.childLabelKey && (
            <div
              data-child-group-label=""
              className="truncate text-[length:var(--font-size-xs)] text-[var(--color-muted)]"
              style={{ paddingLeft: "32px", paddingRight: "var(--sidebar-row-px)", paddingTop: "2px", paddingBottom: "2px" }}
            >
              {t(childSessions[0].childLabelKey)}
            </div>
          )}
          {childSessions.map((c) => {
            const childActive = activeChildPath === c.session.path;
            const childPhase = phaseByPath?.[c.session.neutralSessionId ?? c.session.path] ?? "idle";
            return (
              <ChildSessionRow
                key={c.session.path}
                child={c}
                active={childActive}
                phase={childPhase}
                onSelect={() => onSelectChild?.(c.session)}
                onDelete={onDeleteChild ? () => onDeleteChild(c.session) : undefined}
                onRawPaths={() => onRawPaths(c.session)}
                onOpenRawFile={onOpenRawFile}
              />
            );
          })}
        </div>
      </div>
    )}
    </div>
  );
}

/** 子会话(子 Agent)行:嵌套在父会话下,此前只有「点选切换」,无任何操作入口(问题 C5/C7)。
 *  现在补齐右键菜单:打开原始文件 + 删除(内联确认),与顶层行同语义。数据层已支持级联删。 */
function ChildSessionRow({ child, active, phase, onSelect, onDelete, onRawPaths, onOpenRawFile }: {
  child: ChildSession;
  active: boolean;
  phase: WorkingPhase;
  onSelect: () => void;
  onDelete?: () => Promise<void>;
  onRawPaths?: () => Promise<SessionRawFilePaths>;
  onOpenRawFile?: (path: string | null) => void;
}): React.ReactNode {
  const { t } = useTranslation();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const deletable = active === false; // 活跃子会话不可删(机制兜底:进程 append 会复活文件)

  if (confirmingDelete) {
    return (
      <div
        className="flex items-center gap-2 select-none whitespace-nowrap"
        style={{
          paddingLeft: "32px",
          paddingRight: "var(--sidebar-row-px)",
          paddingTop: "var(--sidebar-row-py)",
          paddingBottom: "var(--sidebar-row-py)",
          border: "1px solid var(--color-accent-danger)",
          borderRadius: "var(--sidebar-row-radius)",
          color: "var(--color-accent-danger)",
          fontSize: "var(--font-size-sm)",
        }}
      >
        <Trash2 className="size-4 shrink-0" />
        <span className="flex-1 min-w-0 truncate leading-tight">{t("sessions.deleteConfirm")}</span>
        <button
          onClick={() => { setConfirmingDelete(false); void onDelete?.(); }}
          title={t("sessions.deleteConfirmYes")}
          className="flex items-center justify-center size-5 shrink-0 rounded-[var(--radius-sm)] bg-transparent border-none cursor-pointer hover:text-[var(--color-fg)]"
          style={{ color: "var(--color-accent-danger)" }}
        >
          <Check className="size-4" />
        </button>
        <button
          onClick={() => setConfirmingDelete(false)}
          title={t("sessions.deleteConfirmNo")}
          className="flex items-center justify-center size-5 shrink-0 rounded-[var(--radius-sm)] bg-transparent border-none cursor-pointer text-[var(--color-muted)] hover:text-[var(--color-fg)]"
        >
          <X className="size-4" />
        </button>
      </div>
    );
  }

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div
          data-session-path={child.session.path}
          // 分叉树的子行同样要标当前项（判据与顶层行一致：active 由 childActive 传入）
          aria-current={active ? "true" : undefined}
          onClick={onSelect}
          className="flex items-center gap-2 cursor-pointer select-none whitespace-nowrap"
          style={{
            paddingLeft: "32px",
            paddingRight: "var(--sidebar-row-px)",
            paddingTop: "var(--sidebar-row-py)",
            paddingBottom: "var(--sidebar-row-py)",
            background: active ? "var(--sidebar-row-bg-active)" : "transparent",
            borderRadius: "var(--sidebar-row-radius)",
            color: active ? "var(--color-fg)" : "var(--color-muted)",
            transition: "background 0.12s",
            fontSize: "var(--font-size-sm)",
          }}
        >
          <div className="shrink-0 flex items-center justify-center" style={{ width: "var(--sidebar-icon-box)", height: "var(--sidebar-icon-box)" }}>
            {phase !== "idle"
              ? <PhaseIcon phase={phase} />
              // 契约 childIcon：分组策略可声明子行图标；未声明才用默认缩进图标。
              // 走 PluginIcon（它对内核 id 走 KernelLogo、其余查 lucide 表、未知回落 Puzzle），
              // 不在这里自己映射图标名——图标解析是机制，只该有一份实现。
              : child.childIcon
                ? <PluginIcon name={child.childIcon} className="text-[var(--color-muted)]" style={{ width: "calc(var(--sidebar-icon-size) * 0.8)", height: "calc(var(--sidebar-icon-size) * 0.8)" }} />
                : <MessageSquare className="text-[var(--color-muted)]" style={{ width: "calc(var(--sidebar-icon-size) * 0.8)", height: "calc(var(--sidebar-icon-size) * 0.8)" }} />}
          </div>
          <div className="flex-1 min-w-0">
            <div className="truncate leading-tight">{deriveSessionTitle(child.session)}</div>
          </div>
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content style={ctxMenuStyle}>
          {onRawPaths && onOpenRawFile && (
            <ContextMenu.Item
              onSelect={() => void onRawPaths().then((p) => onOpenRawFile(p.desktop))}
              style={ctxItemStyle}
            >
              <AppWindow className="size-3.5" /> {t("sessions.openDesktopFile")}
            </ContextMenu.Item>
          )}
          {onRawPaths && onOpenRawFile && (
            <ContextMenu.Item
              onSelect={() => void onRawPaths().then((p) => onOpenRawFile(p.kernel))}
              style={ctxItemStyle}
            >
              <FileJson className="size-3.5" /> {t("sessions.openKernelFile")}
            </ContextMenu.Item>
          )}
          {deletable && onDelete && (
            <ContextMenu.Item data-session-action="delete" onSelect={() => setConfirmingDelete(true)} style={{ ...ctxItemStyle, color: "var(--color-accent-danger)" }}>
              <Trash2 className="size-3.5" /> {t("sessions.delete")}
            </ContextMenu.Item>
          )}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

/** 乐观新建条目(设计 docs/design/optimistic-new-session-entry.md):新对话壳态下的占位行。
 *  与 SessionRow 视觉同构(同 --sidebar-row-* token + active 高亮),但不是真实会话——
 *  无右键菜单、无 hover 操作区、无未读点、无子会话展开、无拖拽;不可改名/置顶/归档/删除。
 *  点击 = 幂等 newSession(与「+」同语义)。图标恒空心 MessageSquare:新对话尚未运行。 */
function NewChatRow({ onClick, sessionPath }: { onClick: () => void; sessionPath: string }): React.ReactNode {
  const { t } = useTranslation();
  return (
    <div
      data-session-path={sessionPath}
      onClick={onClick}
      className="flex items-center gap-2 cursor-pointer select-none whitespace-nowrap"
      style={{
        padding: "var(--sidebar-row-py) var(--sidebar-row-px)",
        background: "var(--sidebar-row-bg-active)",
        border: "var(--sidebar-row-border-active)",
        borderRadius: "var(--sidebar-row-radius)",
        boxShadow: "var(--sidebar-row-shadow-active)",
        color: "var(--color-fg)",
      }}
    >
      <div className="shrink-0 flex items-center justify-center" style={{ width: "var(--sidebar-icon-box)", height: "var(--sidebar-icon-box)" }}>
        <MessageSquare className="text-[var(--color-muted)]" style={{ width: "var(--sidebar-icon-size)", height: "var(--sidebar-icon-size)" }} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="truncate text-[length:var(--font-size-lg)] font-semibold leading-tight text-[var(--color-fg)]">{t("sessions.newChat")}</div>
      </div>
    </div>
  );
}

const ctxMenuStyle: React.CSSProperties = {
  minWidth: "140px",
  background: "var(--color-surface)",
  border: "1px solid var(--color-border)",
  borderRadius: "var(--radius-sm)",
  boxShadow: "var(--shadow-md)",
  padding: "4px",
  zIndex: 99999,
};

const ctxItemStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: "8px",
  padding: "6px 10px", borderRadius: "var(--radius-sm)",
  fontSize: "var(--font-size-base)", color: "var(--color-fg)",
  fontFamily: "var(--font-family-sans)",
  cursor: "pointer", outline: "none",
};

const plusBtnStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "center",
  width: "22px", height: "22px", border: "none", borderRadius: "var(--radius-sm)",
  background: "transparent", color: "var(--color-muted)", cursor: "pointer",
};


