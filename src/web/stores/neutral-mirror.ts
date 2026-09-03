// 中立层镜像 store(renderer 侧,激活会话)——「内容单源」的渲染端投影。
//
// 依据 docs/design/session-single-source.md §3.2/§3.5:
// - 基线:切会话(经 currentNeutralSessionId 变化)时 sessions.getNeutral(ns) 全量读一次;
// - 增量:session:neutralChange 写穿回执,经圆心 applyNeutralChange 归约(与壳同一函数,
//   契约单源);渲染层不拼消息、不比对文本,只有 upsert。
// - 镜像只镜像激活会话:后台会话的变更通知不进来(切换即重读基线)。
//
// 双跑纪律(§5):本镜像与现有 applyEvent 事件路径并行,验证一致前不切换显示读口。
import { create } from "zustand";
import type { NeutralSession, NeutralChange } from "@my-harness-desktop/shared";
import { applyNeutralChange } from "@my-harness-desktop/shared";
import { useUiStore } from "./ui-store";

export interface NeutralMirrorState {
  /** 当前镜像的中立会话主键(null = 无激活会话/新会话未落第一条)。 */
  ns: string | null;
  /** 中立会话镜像(基线读 + 变更归约的产物)。 */
  session: NeutralSession | null;
  /** 变更代际:每条变更通知递增,消费方据此做轻量重算依赖。 */
  nonce: number;
}

export const useNeutralMirror = create<NeutralMirrorState>(() => ({
  ns: null,
  session: null,
  nonce: 0,
}));

/** 加载基线(切会话/镜像缺失时的全量读)。防竞态:拉的期间又切走了就丢弃。 */
async function loadBaseline(ns: string): Promise<void> {
  // 可选调用(与 onHeaderChanged 同先例):旧 mock/旧 API 面无此方法时显式跳过,不炸初始化。
  const getNeutral = window.kernel.sessions.getNeutral?.bind(window.kernel.sessions);
  if (!getNeutral) return;
  const session = (await getNeutral(ns)) as NeutralSession | null;
  if (useUiStore.getState().currentNeutralSessionId !== ns) return;
  useNeutralMirror.setState({ ns, session, nonce: useNeutralMirror.getState().nonce + 1 });
}

let inited = false;

/** 初始化中立层镜像(幂等;经 initSessionStore 挂一次)。 */
export function initNeutralMirror(): void {
  if (inited) return;
  inited = true;

  // 切会话 → 重读基线。清空(ns→null)时镜像同步清空(新会话壳没有中立层对象)。
  let lastNs = useUiStore.getState().currentNeutralSessionId;
  useUiStore.subscribe((state) => {
    if (state.currentNeutralSessionId === lastNs) return;
    lastNs = state.currentNeutralSessionId;
    if (!lastNs) {
      useNeutralMirror.setState({ ns: null, session: null });
      return;
    }
    void loadBaseline(lastNs).catch(() => { /* 主侧未就绪:保持旧镜像,下条变更触发后再试 */ });
  });

  // 写穿回执 → 镜像增量。只收当前镜像会话的(§3.5:后台会话不驱镜像);
  // 镜像缺失(基线未回)时收到变更 → 回拉一次基线兜底,不逐条硬拼。
  // 可选调用:旧 mock 无此订阅时显式降级(与 onHeaderChanged 同先例)。
  window.kernel.sessions.onNeutralChange?.((raw) => {
    const change = raw as NeutralChange;
    const cur = useNeutralMirror.getState();
    if (change.ns !== cur.ns) return;
    if (!cur.session) {
      void loadBaseline(change.ns).catch(() => {});
      return;
    }
    useNeutralMirror.setState({
      session: applyNeutralChange(cur.session, change),
      nonce: cur.nonce + 1,
    });
  });

  // 首次挂载:已有激活会话则补基线
  const initial = useUiStore.getState().currentNeutralSessionId;
  if (initial) void loadBaseline(initial).catch(() => {});
}
