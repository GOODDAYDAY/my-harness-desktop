// skill-aux.tsx —— skill 结构化块:parser(底座格式)+ 折叠渲染器。
//
// 底座 _expandSkillCommand 把 `/skill:name args` 展开成
// `<skill name="…" location="…">\n…\n</skill>\n\nargs` 整块成为用户消息
// content。本文件用底座 parseSkillBlock 同款正则识别,折叠卡展示
// 「已引用技能 name + args 首行」,点开看 SKILL.md 正文(location 不渲染)。
// 依据 docs/design/aux-block-mechanism.md §skill 块。
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, Sparkles } from "lucide-react";
import type { AuxBlock, AuxBlockParser } from "@pi-desktop/contract";

export interface SkillAuxData {
  name: string;
  location: string;
  content: string;
  args?: string;
}

/** 底座 parseSkillBlock 同款格式:块独占开头,args 到结尾。 */
const SKILL_BLOCK_RE = /^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/;

export const auxParsers: AuxBlockParser[] = [
  {
    id: "skill",
    parse(text: string) {
      const m = SKILL_BLOCK_RE.exec(text);
      if (!m) return null;
      const [, name, location, content, args] = m;
      return {
        blocks: [
          {
            type: "skill",
            data: { name, location, content, args: args?.trim() || undefined } satisfies SkillAuxData,
            raw: text,
          },
        ],
      };
    },
  },
];

/** skill 块折叠渲染器(blockRenderers 槽 auxBlock/skill,props 契约 {aux})。
 *  默认一行:「🧠 已引用技能 name」+ args 首行(用户真正输入的部分);
 *  点击展开 SKILL.md 正文。location 是底座注入的机器信息,不渲染。 */
export function SkillAuxBlock({ aux }: { aux: AuxBlock }): React.ReactNode {
  const { t } = useTranslation();
  const data = aux.data as SkillAuxData;
  const [open, setOpen] = useState(false);
  const argLine = data.args?.split("\n")[0]?.trim();
  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-[length:var(--font-size-xs)] text-[var(--color-muted)] cursor-pointer select-none text-left"
      >
        {open ? <ChevronDown className="size-3 flex-none" /> : <ChevronRight className="size-3 flex-none" />}
        <Sparkles className="size-3.5 flex-none text-[var(--color-accent)]" />
        <span className="flex-none">
          {t("timeline.skillRef", { name: data.name })}
        </span>
        {argLine && (
          <span className="truncate min-w-0 opacity-80">· {argLine}</span>
        )}
      </button>
      {open && (
        <div className="px-2.5 pb-2 text-[length:var(--font-size-xs)] text-[var(--color-fg)] whitespace-pre-wrap break-words max-h-64 overflow-y-auto border-t border-[var(--color-border)] pt-2">
          {data.content}
        </div>
      )}
    </div>
  );
}
