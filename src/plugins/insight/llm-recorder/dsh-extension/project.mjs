/**
 * dsh 执行面投影 —— **纯函数，零依赖，可裸单测**。
 *
 * 两个职责，都在"把内核给的东西变成可落盘的行"这一步：
 *   1) `projectRequest`：`GenerateOptions`（`llm/stream` 的完整请求）→ 可 JSON 落盘的投影。
 *   2) `createTurnTracker` / `turnIndexOf`：回合身份。内核在 `session/event` 的 `step/start`
 *      里**自己宣布**了 (turn, step)，记录侧只做"记住最近一次、写在请求行上"。
 *
 * 两条纪律：
 *   · **不构造请求**：投影只做"抄下来 + 丢掉不可序列化的运行时句柄"，不补字段、不改形状。
 *     抄的是 `Object.keys` 全量（只排 `signal`），所以内核将来给 `GenerateOptions` 加字段，
 *     记录自动跟上，不需要改这里——这是"消费而非翻译"在字段粒度上的落法。
 *   · **signal 必须丢**：`options.signal` 是 AbortSignal（活的取消通道），JSON.stringify 出来
 *     是 `{}`；它既不可还原也无记录价值。丢的是句柄，不是信息——请求内容一个字段不少。
 */

/** 折叠进日志的请求字段：除 `signal`（ABORT 通道句柄）外全部原样抄下。 */
export function projectRequest(options) {
  if (options === null || typeof options !== "object") return options;
  const out = {};
  for (const key of Object.keys(options)) {
    if (key === "signal") continue;
    out[key] = options[key];
  }
  return out;
}

/** 回合身份记录：内核宣布 (turn, step) → 记住；请求到达时取用。 */
export function createTurnTracker() {
  /** @type {Map<string, {turn:number, step:number}>} */
  const marks = new Map();
  return {
    /** `session/event` 的 `step/start` → 该会话当前回合/步。 */
    note(sid, turn, step) {
      if (typeof sid !== "string" || !sid) return;
      if (typeof turn !== "number") return;
      marks.set(sid, typeof step === "number" ? { turn, step } : { turn });
    },
    /** 该会话当前回合（无则 undefined）。 */
    current(sid) {
      return marks.get(sid);
    },
    reset(sid) {
      marks.delete(sid);
    },
  };
}

/**
 * 请求行的 `turnIndex`：回合外的内部调用（内核用 `purpose` 标了用途的：compaction /
 * session-title）不带回合号——与 pi 侧"compaction 调用无 turnIndex 字段"同一语义。
 * 注意"字段缺失"而不是 `null`：面板按字段存在性判断，见设计 §3。
 */
export function turnIndexOf(mark, purpose) {
  if (purpose !== undefined && purpose !== null) return undefined;
  if (mark === undefined || mark === null || typeof mark.turn !== "number") return undefined;
  return mark.turn;
}
