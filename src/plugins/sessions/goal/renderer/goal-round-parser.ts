// goal 续跑提示的结构化块解析(纯函数,可裸单测)。
//
// 续跑提示(renderContinuationPrompt 产出的 <goal_round> 包装)经内核落 user/message 后,
// 文本里是「机器包装」不是用户手写内容。本解析器把它从用户消息里整块剥出(渲染成
// 「目标续跑卡」,见 goal-round-card.tsx)——所见即所得的另一半:加了包装就换种方式展示,
// 不冒充用户气泡(用户要求 #5)。
import type { AuxBlock, AuxBlockParser } from "@my-harness-desktop/shared";

export const GOAL_ROUND_BLOCK = "goal_round";

export interface GoalRoundData {
  /** 目标原文(包装里 Objective: 字段的 JSON 解出;解析失败回退原文截断)。 */
  objective: string;
  /** 轮次(1 起);解析不到为 null。 */
  round: number | null;
  /** 轮次上限;解析不到为 null。 */
  maxRounds: number | null;
  /** 包装原文(卡片展开面用)。 */
  raw: string;
}

/** 从 <goal_round> 包装里提取结构化数据。宽松解析:字段缺失时对应字段为 null,不炸。 */
export function parseGoalRoundData(raw: string): GoalRoundData {
  let objective: string | null = null;
  const objMatch = raw.match(/^Objective:\s*(.+)$/m);
  if (objMatch) {
    const rawObj = objMatch[1].trim();
    try {
      const parsed: unknown = JSON.parse(rawObj);
      objective = typeof parsed === "string" ? parsed : rawObj;
    } catch {
      objective = rawObj;
    }
  }
  let round: number | null = null;
  let maxRounds: number | null = null;
  const roundMatch = raw.match(/^Round:\s*(\d+)\s*\/\s*(\d+)\s*$/m);
  if (roundMatch) {
    round = Number.parseInt(roundMatch[1], 10);
    maxRounds = Number.parseInt(roundMatch[2], 10);
  }
  return { objective: objective ?? "", round, maxRounds, raw };
}

/** goal_round 块解析器(renderer 入口经 auxParsers 导出注册;standalone=true:
 *  整段是机器包装,剥掉正文后不再需要「用户消息占位」气泡——卡片自己就是完整呈现)。 */
export const goalRoundParser: AuxBlockParser = {
  id: "goal-round",
  parse(text: string) {
    const re = /<goal_round>\s*([\s\S]*?)\s*<\/goal_round>/g;
    const blocks: AuxBlock[] = [];
    for (const m of text.matchAll(re)) {
      blocks.push({
        type: GOAL_ROUND_BLOCK,
        data: parseGoalRoundData(m[0]),
        start: m.index,
        end: m.index + m[0].length,
        standalone: true,
      });
    }
    return blocks.length > 0 ? { blocks } : null;
  },
};
