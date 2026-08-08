// skill-aux.tsx —— skill 结构化块:parser(底座格式)+ 引用条渲染器。
//
// 底座 _expandSkillCommand 把 `/skill:name args` 展开成
// `<skill name="…" location="…">\n…\n</skill>\n\nargs` 成为用户消息 content。
// 本文件去锚定扫描式识别(块可出现在任意位置),引用条展示
// 「🧠 技能 name · args 首行」,点开看 SKILL.md 正文(location 不渲染)。
// 依据 docs/design/aux-block-mechanism.md §4。
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronUp, Sparkles } from "lucide-react";
import type { AuxBlock, AuxBlockParser } from "@pi-desktop/contract";

export interface SkillAuxData {
  name: string;
  location: string;
  content: string;
  args?: string;
}

/** 去锚定 + matchAll:块出现在任意位置都能识别(组合场景/重试后结构变动);
 *  args 非贪婪 + 前瞻停在下一个块开头,组合场景不吞 review 块(设计 §4.1)。 */
const SKILL_BLOCK_RE = /<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+?))?(?=\n<|$)/g;

export const auxParsers: AuxBlockParser[] = [
  {
    id: "skill",
    parse(text: string) {
      const blocks: AuxBlock[] = [];
      for (const m of text.matchAll(SKILL_BLOCK_RE)) {
        const [, name, location, content, args] = m;
        blocks.push({
          type: "skill",
          data: { name, location, content, args: args?.trim() || undefined } satisfies SkillAuxData,
          start: m.index,
          end: m.index + m[0].length,
        });
      }
      return blocks.length > 0 ? { blocks } : null;
    },
  },
];

/** skill 块引用条渲染器(blockRenderers 槽 auxBlock/skill,props 契约 {aux})。
 *  一行摘要:「🧠 技能 name · args首行」;点击展开 SKILL.md 正文(max-h 限高滚动)。
 *  location 是底座注入的机器信息,不渲染;无点击跳转(skill 引用的是技能不是消息片段)。 */
export function SkillAuxBlock({ aux }: { aux: AuxBlock }): React.ReactNode {
  const { t } = useTranslation();
  const data = aux.data as SkillAuxData;
  const [open, setOpen] = useState(false);
  const argLine = data.args?.split("\n")[0]?.trim();
  return (
    <div className="flex justify-end mt-1">
      <div className="flex flex-col gap-1 items-end max-w-full">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-1.5 text-[length:var(--font-size-xs)] text-[var(--color-muted)] cursor-pointer select-none text-left max-w-full"
        >
          <Sparkles className="size-3.5 flex-none text-[var(--color-accent)]" />
          <span className="flex-none">{t("skill-blocks.skillRef", { name: data.name })}</span>
          {argLine && <span className="truncate min-w-0 opacity-80">· {argLine}</span>}
          {open ? <ChevronUp className="size-3 flex-none" /> : <ChevronDown className="size-3 flex-none" />}
        </button>
        {open && (
          <div className="max-h-64 overflow-y-auto text-[length:var(--font-size-xs)] text-[var(--color-fg)] whitespace-pre-wrap break-words max-w-full">
            {data.content}
          </div>
        )}
      </div>
    </div>
  );
}
