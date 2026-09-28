// @vitest-environment jsdom
// `copyToClipboard` 统一原语的三条路径（r135；原语由 r134 建立，收敛了 9 处各自实现）。
//
// ## 为什么这三条路径都必须测
//
// r134 查明 9 个调用点的失败处理有三种形态且多处静默，其中两个风险是**环境相关**的：
//   ① 非安全上下文（http 远程访问）里 `navigator.clipboard` **整体不存在** ⇒ 7 处会 TypeError；
//   ② API 存在但 `writeText` **reject**（权限被拒 / 页面未聚焦）。
// 这两种在真机 e2e 里都很难造（要 http 远程访问、要拒绝权限），所以按 §5.6 的分工
// 落在 **DOM 交互层**测：jsdom 里可以精确控制 `navigator.clipboard` 的存在与否与成败。
//
// ⚠ 断言用**真实语言包**初始化 i18next（r54/r56/r78/r90 的纪律：给测试真字典，
//   不软化断言、不改写成断言键名）。语言包是带 ns 前缀的扁平键，
//   而 merge 规则是「第一个 dot 前是 namespace」（r78 踩过），故需整形。
// ⚠ 路径层级：packages/react/src/widgets → 仓库根是 **4** 级（r90/r57 同款坑）。

import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import i18next from "i18next";
import { copyToClipboard } from "./clipboard";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHELL_FLAT = JSON.parse(
  readFileSync(join(HERE, "../../../../src/plugins/system/i18n/locales/zh-CN/shell.json"), "utf-8"),
) as Record<string, string>;
const SHELL_NS: Record<string, string> = {};
for (const [k, v] of Object.entries(SHELL_FLAT)) {
  const dot = k.indexOf(".");
  SHELL_NS[dot > 0 ? k.slice(dot + 1) : k] = v;
}
/** 从真字典取译文并做 {{var}} 插值（与 i18next 同语义）；查不到就**炸**，不静默回落（r104 的教训）。 */
function dict(key: string, vars: Record<string, string> = {}): string {
  const bare = key.includes(".") ? key.slice(key.indexOf(".") + 1) : key;
  const tpl = SHELL_NS[bare];
  if (!tpl) throw new Error(`字典里没有 ${key}（测试助手会静默回落成键名，必须先炸出来）`);
  let out = tpl;
  for (const [k, v] of Object.entries(vars)) out = out.split(`{{${k}}}`).join(v);
  return out;
}

/** 取常驻 live region 宿主里的播报节点（announceTransient 渲染出的那个 span）。 */
function announced(): { text: string; role: string | null }[] {
  return [...document.querySelectorAll("[data-announced]")]
    .map((el) => ({ text: (el.textContent ?? "").trim(), role: el.getAttribute("role") }))
    .filter((x) => x.text);
}

describe("copyToClipboard：成功 / 权限被拒 / API 不存在 三条路径", () => {
  const original = Object.getOwnPropertyDescriptor(Navigator.prototype, "clipboard");

  beforeEach(async () => {
    if (!i18next.isInitialized) {
      await i18next.init({
        lng: "zh-CN", fallbackLng: "en", defaultNS: "shell", ns: ["shell"],
        nsSeparator: ".", keySeparator: ".",
        interpolation: { escapeValue: false, prefix: "{{", suffix: "}}" },
        returnEmptyString: false,
        resources: { "zh-CN": { shell: SHELL_NS } },
      });
    }
    document.body.innerHTML = "";
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (original) Object.defineProperty(Navigator.prototype, "clipboard", original);
  });

  function setClipboard(v: unknown): void {
    Object.defineProperty(Navigator.prototype, "clipboard", { configurable: true, value: v });
  }

  it("判据不空转：真字典里两条文案都在，且不是键名", () => {
    for (const k of ["shell.clipboardFailed", "shell.clipboardUnavailable"]) {
      const v = dict(k);
      expect(v, `${k} 应在语言包里`).toBeTruthy();
      expect(v).not.toBe(k);
    }
    expect(dict("shell.clipboardFailed", { detail: "X" })).toContain("X");
    expect(dict("shell.clipboardUnavailable").length, "不可用文案应给出可执行指引，不该是一两个字").toBeGreaterThan(10);
  });

  it("① 成功：返回 true，且**不**播报（成功不该打断用户）", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    const ok = await copyToClipboard("要复制的文本");
    expect(ok).toBe(true);
    expect(writeText).toHaveBeenCalledWith("要复制的文本");
    expect(announced(), "成功路径不该产生播报（9 个调用点自己会显示『已复制』态）").toEqual([]);
  });

  it("② 权限被拒：返回 false、不抛，并播报**可打断**的失败原因", async () => {
    setClipboard({ writeText: vi.fn().mockRejectedValue(new Error("NotAllowedError: permission denied")) });
    const ok = await copyToClipboard("x");
    expect(ok, "失败必须用返回值表达，不能抛（调用方在 onClick 里，抛出去就是 unhandled rejection）").toBe(false);
    const a = announced();
    expect(a.length, "失败必须播报（§7.6 禁止静默失败）").toBeGreaterThan(0);
    expect(a[0].text).toContain(dict("shell.clipboardFailed", { detail: "" }).split("：")[0]);
    expect(a[0].text, "播报要含真实原因，否则用户不知道为什么失败").toContain("NotAllowedError");
    expect(a[0].role, "错误要用可打断的 role=alert（r59/r61：播报强度属于语义）").toBe("alert");
  });

  it("③ API 不存在（非安全上下文）：返回 false、不抛 TypeError，并给出**可执行指引**", async () => {
    setClipboard(undefined);   // http 远程访问下 navigator.clipboard 就是 undefined
    const ok = await copyToClipboard("x");
    expect(ok, "r134 查明：9 处里只有 2 处记得写 ?.，其余 7 处在这种情况下会直接 TypeError").toBe(false);
    const a = announced();
    expect(a.length).toBeGreaterThan(0);
    // 这种情况下播报的是"环境不提供剪贴板"这条**专门**的文案（含改用本机/https 的指引），
    // 而不是把 "clipboard-unavailable" 这个内部标记当成原因丢给用户
    expect(a[0].text, "应给出环境不可用的专门指引").toContain(dict("shell.clipboardUnavailable").slice(0, 8));
    expect(a[0].text, "内部标记不得泄漏到用户可见文案里").not.toContain("clipboard-unavailable");
  });

  it("⑤ 防回潮：原语之外**任何**渲染侧文件都不得直接调 navigator.clipboard", () => {
    // r134 把 9 处各自实现收敛成一个原语；这条断言守住它不被重新打散。
    // 为什么要守：分散调用的害处不是"代码重复"，而是**失败处理会各自漂移**
    // （r134 实测三种形态、多处静默），而下一个人加第 10 处时不会知道有原语。
    const { readdirSync, statSync, readFileSync: rf } = require("node:fs") as typeof import("node:fs");
    const { join: j } = require("node:path") as typeof import("node:path");
    const ROOT = j(HERE, "../../../..");
    const roots = ["src/web", "src/plugins", "packages/react/src"];
    const walk = (d: string, out: string[] = []): string[] => {
      if (!statSync(d, { throwIfNoEntry: false })) return out;
      for (const n of readdirSync(d)) {
        const f = j(d, n);
        const st = statSync(f);
        if (st.isDirectory()) { if (n !== "node_modules" && n !== "locales" && !n.startsWith(".")) walk(f, out); }
        else if (/\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n)) out.push(f);
      }
      return out;
    };
    const files = roots.flatMap((r) => walk(j(ROOT, r)));
    expect(files.length, `渲染侧语料只有 ${files.length} 个文件 ⇒ 路径判据可能坏了`).toBeGreaterThan(120);
    const SELF = j(ROOT, "packages/react/src/widgets/clipboard.ts");
    const bad = files
      .filter((f) => f !== SELF)
      .filter((f) => /navigator\s*\.\s*clipboard/.test(
        rf(f, "utf-8").replace(/\/\*[\s\S]*?\*\//g, "").split("\n")
          .filter((l) => !l.trim().startsWith("//")).join("\n")))
      .map((f) => f.replace(ROOT + "/", ""));
    expect(bad, [
      `${bad.length} 个文件绕开 copyToClipboard 直接用了 navigator.clipboard：${bad.join(", ")}`,
      "      用原语（packages/react 发布面的 copyToClipboard）：它不抛、失败自己播报、",
      "      并处理了『API 不存在』（非安全上下文，例如 http 远程访问）这种情况。",
      "      直接调用的害处不是代码重复，而是**失败处理会各自漂移**——",
      "      r134 实测 9 处有三种形态、多处静默，其中复制密码那处静默最危险。",
    ].join("\n")).toEqual([]);
  });

  it("④ API 存在但没有 writeText（形状不完整）也要按不可用处理，不能 TypeError", async () => {
    setClipboard({});   // 某些浏览器/嵌入环境会给一个残缺对象
    await expect(copyToClipboard("x")).resolves.toBe(false);
    expect(announced().length).toBeGreaterThan(0);
  });
});
