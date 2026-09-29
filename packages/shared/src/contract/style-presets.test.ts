// 样式预设契约的派生关系断言（r252；消化发布面零测试引用清单里的两个 *_STYLE_PRESET_MAP）。
//
// ## 钉的性质
//
// 这份文件是"左栏/右面板风格预设"的**唯一 TS 源**（文件头注写明：样式内容的唯一真源是
// index.css 的 [data-*-style="<id>"] 属性选择器块，这里只持清单契约 id + labelKey，
// 不再持有任何样式值副本——历史上三处副本已经开始漂移）。
// 所以这里要钉的不是"样式值对不对"（那在 CSS 里、由预览卡走同一条 CSS 路径保证），
// 而是**清单与查表之间的派生关系**：
//
// ① MAP 是清单的派生：清单里每一项都能按 id 查到、且查到的就是那一项（同一引用）；
// ② MAP 的条目数 == 清单长度（多出来说明有 stale 条目、少说明有 id 重复被覆盖）；
// ③ 表外 id ⇒ undefined（不是抛错、不是回落到某一项）——消费方据此判"未知样式"；
// ④ 左栏与右面板是**同一族 id**（文件头注：'与左栏同一族值'）⇒ 两份清单的 id 集合相同；
// ⑤ labelKey 的形状是 settings.style.<id>（键名与 id 一一对应；这是 i18n 单源的契约面，
//    缺键会渲染成裸键名——那类缺陷由 code-i18n-keys 守卫负责，这里钉形状不重复钉存在性）。
//
// ⚠ 这是圆心契约（packages/shared/src/contract），纯数据 ⇒ 裸单测、零 mock（§4.5）。

import { describe, it, expect } from "vitest";
import {
  SIDEBAR_STYLE_PRESETS, SIDEPANEL_STYLE_PRESETS,
  SIDEBAR_STYLE_PRESET_MAP, SIDEPANEL_STYLE_PRESET_MAP,
} from "./style-presets";

const PAIRS = [
  ["左栏", SIDEBAR_STYLE_PRESETS, SIDEBAR_STYLE_PRESET_MAP],
  ["右面板", SIDEPANEL_STYLE_PRESETS, SIDEPANEL_STYLE_PRESET_MAP],
] as const;

describe("样式预设：清单 ⇄ 查表的派生关系", () => {
  for (const [label, list, map] of PAIRS) {
    it(`①② ${label}：MAP 由清单派生（每项可按 id 查到、条目数与清单一致）`, () => {
      expect(list.length, "清单不该为空（空了预览卡就没得选）").toBeGreaterThan(0);
      for (const p of list) {
        expect(map[p.id], `${label} 的 ${p.id} 要能按 id 查到`).toBe(p);
      }
      expect(Object.keys(map).length,
        `${label} MAP 条目数应等于清单长度（多=有 stale 条目，少=有 id 重复被覆盖）`).toBe(list.length);
    });

    it(`③⑤ ${label}：表外 id ⇒ undefined；labelKey 形状是 settings.style.<id>`, () => {
      expect(map["never-a-style-id"], "未知 id 不该回落到某一项（消费方据此判'未知样式'）").toBeUndefined();
      for (const p of list) {
        expect(p.labelKey, `${p.id} 的 labelKey 要与 id 一一对应`).toBe(`settings.style.${p.id}`);
      }
    });
  }

  it("④ 左栏与右面板是同一族 id（头注：'与左栏同一族值'）", () => {
    const a = SIDEBAR_STYLE_PRESETS.map((p) => p.id).sort();
    const b = SIDEPANEL_STYLE_PRESETS.map((p) => p.id).sort();
    expect(b, "两份清单的 id 集合应相同（独立清单是契约形状最直白的形式，但值同族）").toEqual(a);
  });
});
