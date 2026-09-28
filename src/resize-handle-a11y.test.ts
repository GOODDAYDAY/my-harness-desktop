// 所有可拖拽分隔条（`PanelResizeHandle`）都必须带可访问名与朝向 —— **静态**守卫。
//
// ## 为什么运行时普查不够，还要这一条
//
// `scripts/demo/a11y-names-audit.e2e.mjs` 会在真机里走遍 23 个视图普查分隔条的
// `aria-label` / `aria-orientation` / `tabIndex` / `aria-valuenow`。但普查只能看见
// **当时渲染出来的**手柄：右面板的分隔条只在"2 个以上堆叠 TAB"时才渲染
// （`right-panel.tsx` 的 `i < renderIds.length - 1`），默认布局下根本不出现，
// 于是 r39 实测普查只看到 3 个，而全仓有 **4 个**站点。
// 未被渲染 ≠ 无缺陷 —— 用户把右面板拉成堆叠布局时它就在，而那时没人测过。
//
// ## 缺陷本体（r39 实测）
//
// `react-resizable-panels` 的 `PanelResizeHandle` 会给出 `role="separator"`、
// `aria-valuenow/min/max`、`tabIndex=0`、`aria-controls`，但**不给可访问名，也不给朝向**
// （实测 4 处全是 `aria-label=null`、`aria-orientation=null`）。两个后果：
//   ① 读屏只念"分隔条 19"，不知道它分隔的是什么；
//   ② `aria-orientation` 缺省时按 ARIA 落到 `horizontal`，而 `col-resize` 的手柄是
//      **竖向**分隔条（分隔左右、水平移动）——默认值对它是**错的**，
//      读屏会给出相反的方向提示（用户按↑↓调，实际要按←→）。
//
// ## 判据
//
// 扫 `src/web` 与 `packages/react/src` 的每个 `<PanelResizeHandle`，要求同一元素上
// 同时出现 `aria-label` 与 `aria-orientation`。用**源码**判而不是 DOM 判，
// 正好补上"未渲染的站点"这个盲区。

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SCAN_ROOTS = ["src/web", "packages/react/src"];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) { if (name !== "node_modules") walk(full, out); }
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

interface Site { file: string; line: number; hasLabel: boolean; hasOrient: boolean; snippet: string }

function sites(): Site[] {
  const out: Site[] = [];
  for (const base of SCAN_ROOTS) {
    const abs = join(ROOT, base);
    if (!existsSync(abs)) continue;
    for (const f of walk(abs)) {
      const lines = readFileSync(f, "utf-8").split("\n");
      lines.forEach((l, i) => {
        if (!l.includes("<PanelResizeHandle")) return;
        // 同一元素的属性块：从这里往后到第一个 ">" 结束（JSX 开标签）
        let end = i;
        for (let j = i; j < Math.min(lines.length, i + 40); j++) {
          end = j;
          if (/>/.test(lines[j].replace(/=>/g, ""))) break;
        }
        const block = lines.slice(i, end + 1).join("\n");
        out.push({
          file: relative(ROOT, f), line: i + 1,
          hasLabel: /aria-label=/.test(block),
          hasOrient: /aria-orientation=/.test(block),
          snippet: block.replace(/\s+/g, " ").slice(0, 110),
        });
      });
    }
  }
  return out;
}

describe("可拖拽分隔条：aria-label 与 aria-orientation 必须显式给出", () => {
  const found = sites();

  it("判据不空转：确实扫到了分隔条站点，且数量与已知事实一致", () => {
    // r39 实测全仓 4 处（settings-page / right-panel / sidebar / layout-engine）。
    // 少于 4 说明扫描路径或匹配坏了（假绿）；多于 4 说明新增了站点 —— 那也必须带 aria。
    expect(found.length, `扫到的 <PanelResizeHandle> 站点数异常（${found.length}）`).toBeGreaterThanOrEqual(4);
    const files = [...new Set(found.map((s) => s.file))];
    expect(files.length, "站点分布的文件数异常").toBeGreaterThanOrEqual(3);
  });

  it("① 每个站点都有 aria-label（否则读屏只念「分隔条 <数值>」，不知道分隔的是什么）", () => {
    const bad = found.filter((s) => !s.hasLabel);
    expect(bad.map((s) => `${s.file}:${s.line}\n        ${s.snippet}`),
      `缺 aria-label 的分隔条 ${bad.length} 处：\n      ` + bad.map((s) => `${s.file}:${s.line}`).join("\n      ")).toEqual([]);
  });

  it("② 每个站点都有 aria-orientation（缺省会落到 ARIA 默认值 horizontal，对 col-resize 的手柄是错的）", () => {
    const bad = found.filter((s) => !s.hasOrient);
    expect(bad.map((s) => `${s.file}:${s.line}`),
      `缺 aria-orientation 的分隔条 ${bad.length} 处：\n      ` + bad.map((s) => `${s.file}:${s.line}\n        ${s.snippet}`).join("\n      ")).toEqual([]);
  });

  it("③ aria-label 走 i18n 而不是写死文案（壳不许内嵌功能性内容，§1.2）", () => {
    const hardcoded = found.filter((s) => /aria-label=["']/.test(s.snippet));
    expect(hardcoded.map((s) => `${s.file}:${s.line} ${s.snippet}`),
      "分隔条的可访问名写死了字面量，应改为 t(…)").toEqual([]);
  });
});
