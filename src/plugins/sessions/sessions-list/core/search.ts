// sessions-list 搜索过滤纯函数(renderer → core 分层:渲染只消费,匹配逻辑可裸单测)。
//
// 问题 D9:此前搜索只匹配 name + created,未命名会话(标题退化成 id 前 8 位)无法检索。
// 修法:把 id(根 lineage id)与 neutralSessionId 一并纳入匹配键,未命名会话按它显示的
// id 前缀也能搜到。匹配保持大小写敏感(与旧行为一致,不扩大改动面)。
import type { SessionInfo } from "@my-harness-desktop/react";

/** 按 query 过滤会话:name / created / id / neutralSessionId 四键任一命中即保留。
 *  query 为空 → 原样返回(不过滤)。 */
export function filterSessions(sessions: SessionInfo[], query: string): SessionInfo[] {
  if (!query) return sessions;
  return sessions.filter((s) =>
    (s.name ?? "").includes(query)
    || s.created.includes(query)
    || (s.id ?? "").includes(query)
    || (s.neutralSessionId ?? "").includes(query),
  );
}
