// @vitest-environment jsdom
// `pickDirectory` 原语的三条路径（r151；原语由 r137 建立，收敛了 3 处各自裸 await 的调用点）。
//
// 与 r135 的 copyToClipboard 同族：都是"用户动作 + 能力可能在某些宿主下不存在"，
// 失败必须**播报**（§7.6）而不是静默，且不抛（调用方在 onClick 里，抛出去就是 unhandled rejection）。
//
// ⚠ 断言用**真实语言包**（r54/r56/r90 的纪律：给测试真字典，不软化断言）。
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import i18next from "i18next";
import { pickDirectory } from "./pick-directory";

const HERE = dirname(fileURLToPath(import.meta.url));
const FLAT = JSON.parse(
  // ⚠ widgets/ → 仓库根是 4 级（r151 又踩了一次；同 r57/r90/r91/r144）
  readFileSync(join(HERE, "../../../../src/plugins/system/i18n/locales/zh-CN/shell.json"), "utf-8"),
) as Record<string, string>;
const NS: Record<string, string> = {};
for (const [k, v] of Object.entries(FLAT)) {
  const d = k.indexOf(".");
  NS[d > 0 ? k.slice(d + 1) : k] = v;
}
function dict(key: string, vars: Record<string, string> = {}): string {
  const bare = key.includes(".") ? key.slice(key.indexOf(".") + 1) : key;
  const tpl = NS[bare];
  if (!tpl) throw new Error(`字典里没有 ${key}`);
  let out = tpl;
  for (const [k, v] of Object.entries(vars)) out = out.split(`{{${k}}}`).join(v);
  return out;
}
function announced(): string[] {
  return [...document.querySelectorAll("[data-announced]")]
    .map((el) => (el.textContent ?? "").trim()).filter(Boolean);
}

describe("pickDirectory：成功 / 取消 / 能力不可用", () => {
  beforeEach(async () => {
    if (!i18next.isInitialized) {
      await i18next.init({
        lng: "zh-CN", fallbackLng: "en", defaultNS: "shell", ns: ["shell"],
        nsSeparator: ".", keySeparator: ".", interpolation: { escapeValue: false },
        returnEmptyString: false, resources: { "zh-CN": { shell: NS } },
      });
    }
    document.body.innerHTML = "";
  });

  it("判据不空转：真字典里有失败文案，且给出可执行指引", () => {
    const v = dict("shell.directoryPickerFailed", { detail: "X" });
    expect(v).toContain("X");
    expect(v.length, "应含指引，不该只有一两个字").toBeGreaterThan(10);
  });

  it("① 用户选了目录 ⇒ 返回该路径，且**不**播报", async () => {
    const ctx = { dialog: { openDirectory: vi.fn().mockResolvedValue("/abs/proj") } };
    await expect(pickDirectory(ctx)).resolves.toBe("/abs/proj");
    expect(announced(), "成功不该打断用户").toEqual([]);
  });

  it("② 用户**取消** ⇒ 返回 null，且**不**播报（取消是正常操作，播报是噪音）", async () => {
    const ctx = { dialog: { openDirectory: vi.fn().mockResolvedValue(null) } };
    await expect(pickDirectory(ctx)).resolves.toBeNull();
    expect(announced(), "取消不该被当成失败播报").toEqual([]);
  });

  it("③ 能力不可用（远程/浏览器宿主 UNSUPPORTED_HOST）⇒ 返回 null、**不抛**、并播报指引", async () => {
    const ctx = { dialog: { openDirectory: vi.fn().mockRejectedValue(new Error("UNSUPPORTED_HOST")) } };
    await expect(pickDirectory(ctx), "不抛：调用方在 onClick 里，抛出去就是 unhandled rejection").resolves.toBeNull();
    const a = announced();
    expect(a.length, "失败必须播报（§7.6 禁止静默）").toBeGreaterThan(0);
    expect(a[0]).toContain("UNSUPPORTED_HOST");
  });
});
