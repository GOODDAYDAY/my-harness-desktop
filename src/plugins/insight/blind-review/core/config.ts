// 配置契约与解析 —— 纯 TS,不 import react、不碰 ctx,可裸单测。
//
// 蓝队编制模型(对齐 docs/plugins/blind-review.md §3.2):
// - 一个模板 = 一个蓝队:access 定访问级别(黑盒/白盒),enabled 定是否加入编制
// - judge = 裁判:汇总各队报告(去重/分级/标共识),不是对答案的判分者
// - 旧配置兼容:无 access/enabled/judge 时 resolveConfig 补默认
//
// 默认编制的内容(队名/prompt/裁判)由调用方按界面语言经 DefaultContentDict 注入——
// core 不硬编码任何自然语言文案(机制与内容分离:i18n 文案归 locales)。

/** 访问级别:content=黑盒仅内容;project=白盒,附项目文件树({{tree}} 占位)。 */
export type AccessLevel = "content" | "project";

/** 一个蓝队(即一个 prompt 模板)。 */
export interface TeamConfig {
  id: string;
  name: string;
  access: AccessLevel;
  enabled: boolean;
  prompt: string;
}

/** 裁判模板:{{content}} 被审内容,{{reports}} 各队报告拼装。 */
export interface JudgeConfig {
  name: string;
  prompt: string;
}

export interface BlindReviewConfig {
  prompts: TeamConfig[];
  defaultPromptId: string;
  judge: JudgeConfig;
}

/** 默认编制的文案字典(renderer 按界面语言从 locales 组好注入;id/access/enabled 是机制,不在字典里)。 */
export interface DefaultContentDict {
  teams: { id: string; name: string; prompt: string }[];
  judgeName: string;
  judgePrompt: string;
}

/** 默认编制的机制骨架:id/access 固定(契约),文案由 dict 填充。 */
const DEFAULT_TEAM_SKELETON: { id: string; access: AccessLevel }[] = [
  { id: "correctness", access: "content" },
  { id: "security", access: "content" },
  { id: "logic", access: "content" },
  { id: "hidden-intent", access: "project" },
];

export function defaultConfig(dict: DefaultContentDict): BlindReviewConfig {
  const byId = new Map(dict.teams.map((t) => [t.id, t]));
  return {
    prompts: DEFAULT_TEAM_SKELETON.map((sk) => {
      const d = byId.get(sk.id);
      return { id: sk.id, name: d?.name ?? sk.id, access: sk.access, enabled: true, prompt: d?.prompt ?? "" };
    }),
    defaultPromptId: DEFAULT_TEAM_SKELETON[0].id,
    judge: { name: dict.judgeName, prompt: dict.judgePrompt },
  };
}

/** 解析配置:兼容旧版(无 access/enabled/judge),字段缺失补默认;无有效模板回退整份默认。 */
export function resolveConfig(raw: Record<string, unknown> | null, dict: DefaultContentDict): BlindReviewConfig {
  if (!raw || !raw.prompts || !Array.isArray(raw.prompts) || raw.prompts.length === 0) {
    return defaultConfig(dict);
  }
  const prompts: TeamConfig[] = (raw.prompts as Record<string, unknown>[])
    .filter((p) => p && p.id && p.name && p.prompt)
    .map((p) => ({
      id: String(p.id),
      name: String(p.name),
      access: p.access === "project" ? "project" : "content",
      enabled: p.enabled !== false,
      prompt: String(p.prompt),
    }));
  if (prompts.length === 0) return defaultConfig(dict);
  const rawJudge = raw.judge as Record<string, unknown> | undefined;
  const fallback = defaultConfig(dict);
  const judge: JudgeConfig =
    rawJudge && typeof rawJudge.prompt === "string" && rawJudge.prompt.trim()
      ? { name: typeof rawJudge.name === "string" ? rawJudge.name : fallback.judge.name, prompt: rawJudge.prompt }
      : fallback.judge;
  return {
    prompts,
    defaultPromptId: typeof raw.defaultPromptId === "string" ? raw.defaultPromptId : prompts[0].id,
    judge,
  };
}

/** 编制清单:本次蓝队盲审出场的队(enabled 保持配置顺序)。 */
export function squadTeams(cfg: BlindReviewConfig): TeamConfig[] {
  return cfg.prompts.filter((p) => p.enabled);
}
