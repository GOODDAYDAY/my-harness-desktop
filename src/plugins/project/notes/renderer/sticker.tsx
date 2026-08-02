// 贴纸（sticker）视觉基座 —— notes 插件的"便利贴"身份。
//
// 取舍：
// - 颜色全部吃主题 token（不引入纸色数据字段），贴纸感来自几何与装饰：
//   轻微倾斜 + 软投影 + 方形小圆角 + 顶部胶带/图钉。
// - 倾角与装饰由笔记 id 哈希决定——同一张卡每次渲染歪得一模一样，不随重渲染跳动；
//   胶带/图钉按哈希各分一半，同一张卡不堆两种装饰。
// - hover 时回正 + 微放大 + 阴影加深（"被拈起来"），用 React hover 态实现，
//   不依赖 tailwind 任意属性语法。

import { useState, type CSSProperties, type ReactNode } from "react";

/** djb2 字符串哈希 → 稳定正整数。 */
function hashId(id: string): number {
  let h = 5381;
  for (let i = 0; i < id.length; i++) h = ((h << 5) + h + id.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export type StickerDeco = "tape" | "pin";

export interface StickerPose {
  /** 倾角（度），-1.6 ~ +1.6，0.1 步进。 */
  tilt: number;
  deco: StickerDeco;
}

/** 由笔记 id 推出稳定姿态：倾角 + 装饰（胶带/图钉各半）。 */
export function stickerPose(id: string): StickerPose {
  const h = hashId(id);
  return { tilt: (h % 33) / 10 - 1.6, deco: (h >> 5) % 2 === 0 ? "tape" : "pin" };
}

/** 顶部胶带：半透明一小条，主题 fg 低透明度混出"塑料胶带"感，明暗主题都成立。 */
function Tape(): ReactNode {
  return (
    <div
      aria-hidden
      style={{
        position: "absolute",
        top: -7,
        left: "50%",
        width: 56,
        height: 14,
        transform: "translateX(-50%) rotate(-2.5deg)",
        background: "color-mix(in srgb, var(--color-fg) 14%, transparent)",
        boxShadow: "0 1px 2px rgb(0 0 0 / 0.08)",
        borderRadius: 1,
        pointerEvents: "none",
      }}
    />
  );
}

/** 顶部图钉：主题 primary 的小圆钉 + 高光 + 投影。 */
function Pin(): ReactNode {
  return (
    <div
      aria-hidden
      style={{
        position: "absolute",
        top: -8,
        left: "50%",
        width: 11,
        height: 11,
        transform: "translateX(-50%)",
        borderRadius: "50%",
        background:
          "radial-gradient(circle at 35% 30%, color-mix(in srgb, var(--color-primary) 45%, white), var(--color-primary) 65%)",
        boxShadow: "0 1px 3px rgb(0 0 0 / 0.35)",
        pointerEvents: "none",
      }}
    />
  );
}

interface StickerCardProps {
  /** 笔记 id：给出则按 id 摆姿态（倾斜 + 装饰）；缺省 = 平整卡（编辑器用，不歪不装饰）。 */
  noteId?: string;
  children: ReactNode;
  style?: CSSProperties;
}

/** 贴纸卡容器：方形小圆角 + 软投影 + 稳定倾斜，hover 回正放大像被拈起。 */
export function StickerCard({ noteId, children, style }: StickerCardProps): ReactNode {
  const [hover, setHover] = useState(false);
  const pose = noteId ? stickerPose(noteId) : null;
  const lifted = hover && pose !== null;
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: "relative",
        // 装饰会探进卡片上缘几像素，有姿态的卡补一点顶距，别压住标题文字
        padding: pose ? "calc(var(--spacing-sm) + 6px) var(--spacing-md) var(--spacing-sm)" : "var(--spacing-sm) var(--spacing-md)",
        background: "var(--color-surface)",
        borderRadius: 3,
        color: "var(--color-surface-fg)",
        transform: pose ? (lifted ? "rotate(0deg) scale(1.03)" : `rotate(${pose.tilt}deg)`) : undefined,
        boxShadow: lifted ? "var(--shadow-lg)" : "var(--shadow-md)",
        transition:
          "transform var(--motion-duration-fast) var(--motion-ease-standard), box-shadow var(--motion-duration-fast) var(--motion-ease-standard)",
        ...style,
      }}
    >
      {pose?.deco === "tape" && <Tape />}
      {pose?.deco === "pin" && <Pin />}
      {children}
    </div>
  );
}
