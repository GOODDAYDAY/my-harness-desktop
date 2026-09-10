// 静态守卫:分割线的"线视觉" token 不许退回成"能不能拖"的开关(§3.7 守卫闭环)。
//
// 根因背景(左右两处都踩过,同一形状):card / minimal / glass 三个风格把
// `--{area}-divider-display` 设成 none —— 这个 token 当时挂在 **PanelResizeHandle 本身**
// 的 display 上,于是"这个风格不要分割线"被物理地翻译成"取消这个交互点":那三种风格下
// 两块之间的高度比彻底调不了,而且类型/lint/运行时全绿、零报错,只能靠手感觉察。
// 修法(左栏 sidebar.tsx、右面板 right-panel.tsx 均已落地)= 手柄热区恒 `display:"flex"`
// (壳写死的 8px),只有**内线**的显隐走 `--{area}-divider-visual-display`。
//
// 三条不变量(注释里提到旧 token 名不算违规,故匹配的都是"真源码形状"):
//   ① 没有任何 `--x-divider-display:` 声明(风格只许管线,不许管热区);
//   ② 没有任何热区把 display 绑到 divider token 上(`display: "var(--x-divider-display)"`);
//   ③ 正向:visual 版 token 在样式里声明、在两侧手柄里被消费,且两处手柄都写死 display:"flex"
//      ——防"改名+守卫一起漂移成零命中全绿"。
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const WEB_ROOT = resolve(__dirname, "..");
/** 两个"token 化手柄"的所在文件(其余手柄写死几何,不受风格 token 影响)。 */
const HANDLE_FILES = ["components/sidebar.tsx", "components/right-panel.tsx"];

/** 递归收集 src/web 下的生产源码(排除测试:测试文件里有意出现旧 token 字面量)。 */
function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { yield* walk(p); continue; }
    if (/\.test\.tsx?$/.test(name)) continue;
    if (/\.(ts|tsx|css)$/.test(name)) yield p;
  }
}

const files = [...walk(WEB_ROOT)].map((p) => ({ rel: p.slice(WEB_ROOT.length + 1), src: readFileSync(p, "utf-8") }));

const collect = (re: RegExp): string[] =>
  files.flatMap(({ rel, src }) => [...src.matchAll(re)].map((m) => `${rel}: ${m[0].trim()}`));

describe("分割线 token 命名:线的视觉 ≠ 热区的可交互性", () => {
  it("没有任何非 visual 的 --*-divider-display 声明(风格只许管线)", () => {
    expect(collect(/--[a-z0-9-]*-divider-display\s*:/g)).toEqual([]);
  });

  it("没有任何热区把 display 绑到 divider token 上(热区不许被风格关掉)", () => {
    expect(collect(/display:\s*["']?var\(\s*--[a-z0-9-]*-divider-display\s*\)/g)).toEqual([]);
  });

  it("visual 版 token 在样式里声明、在两个手柄里消费(防改名漂移成零命中全绿)", () => {
    const declarations = collect(/--[a-z0-9-]*-divider-visual-display\s*:/g);
    const consumers = collect(/var\(\s*--[a-z0-9-]*-divider-visual-display\s*\)/g);
    expect(declarations.length).toBeGreaterThanOrEqual(2); // 左栏 + 右面板各一份(含各风格覆写更多)
    expect(consumers.length).toBeGreaterThanOrEqual(2);    // sidebar.tsx + right-panel.tsx 各自的内线
  });

  it("两个 token 化手柄的拖拽热区都写死 display:'flex'(热区恒定,不随风格漂)", () => {
    for (const rel of HANDLE_FILES) {
      const file = files.find((f) => f.rel === rel);
      expect(file, `${rel} 应存在`).toBeTruthy();
      expect(/display:\s*"flex"/.test(file!.src), `${rel} 的手柄热区应写死 display:"flex"`).toBe(true);
    }
  });
});
