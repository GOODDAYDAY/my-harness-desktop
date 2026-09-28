// 思考档位下拉的派生规则 —— 纯函数，从 timeline 的 index.tsx 抽出以便裸单测。
//
// 为什么要抽出来（而不是留在组件里）：这两条规则是**能力面分轴**之后唯一还带分支策略的地方，
// 而组件本身有 1300+ 行、渲染一次要挂整套插件上下文，用它测两条 if 分支成本高且脆。
// 抽成纯函数后：规则可裸单测（§4.5 判据：不碰 IO/环境/状态 = 内层材料），组件只负责渲染结果。
//
// 判据来源（勿凭直觉改）：
//   · 档位清单语义 `levelsSemantics` 由**内核自报**（圆心 `ThinkingCapabilities`）：
//     `approximate` = 内核给的是全局档位表，且 RPC 响应形状不识别时会返空
//     （pi 的 `getThinkingLevels` 在 `data.levels` 形状不符时返回 `[]`）→ 空清单可回落已知默认；
//     `precise`（缺省）= 内核给的是**当前模型**的精确清单 → 空就是「该模型无档位」，
//     必须如实不渲染，**不许拿默认清单伪造可切**（CLAUDE.md §1.5「不静默、不伪造成功」）。
//   · 曾用的判据是「有没有 pi 扩展面」（`capabilities.extension`）——那是拿内核身份当语义代理，
//     第四个内核无从表达自己属于哪一种，已退役。
import type { SessionCapabilities } from "@my-harness-desktop/shared";

/** 派生「档位下拉该渲染哪些档位」。
 *
 *  三种结果，逐个对应一种真实状态：
 *  ① 无 thinking 面 → `[]`（该内核没有档位概念，下拉不画）；
 *  ② `approximate` 且内核清单为空 → 回落 `fallback`（清单不可靠时的已知默认，与历史行为一致）；
 *  ③ 其余（precise，或 approximate 但清单非空）→ 原样用内核清单。 */
export function deriveThinkingLevels(opts: {
  faces: SessionCapabilities["faces"];
  levelsSemantics: SessionCapabilities["levelsSemantics"];
  /** 内核返回的清单（`refreshThinkingLevels` 拉到的值）。 */
  fromKernel: string[];
  /** `approximate` 语义下清单为空时的回落档位表。 */
  fallback: string[];
}): string[] {
  if (!opts.faces.thinking) return [];
  if (opts.levelsSemantics === "approximate" && opts.fromKernel.length === 0) return opts.fallback;
  return opts.fromKernel;
}

/** 派生「运行时切档不可用」提示该不该出（出了就把思考开关置灰并悬浮真实原因）。
 *
 *  判据是**成员级**的：有档位清单面（能查）但没有运行时轮转面（不能切）→ 提示。
 *  两个都在 → 不提示；连清单面都没有 → 也不提示（此时整个思考域本就不渲染，
 *  再挂一个「不支持切换」的提示是噪声）。
 *  曾用 `capabilities.thinking && !capabilities.extension` 表达同一意思——
 *  那是「有 dsh 补面而无 pi 扩展面」的内核身份代理，已退役。 */
export function shouldHintThinkingUnavailable(caps: Pick<SessionCapabilities, "faces" | "thinkingCycle">): boolean {
  return Boolean(caps.faces.thinking) && !caps.thinkingCycle;
}
