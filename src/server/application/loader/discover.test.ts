// discoverPlugins 的顺序确定性单测（r70）。
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverPlugins } from "./discover";

// ── r70：同一 source 内的发现顺序必须**确定**（按 manifest.id 字典序），
//    不得沿用 readdirSync 的文件系统枚举序。
//    为什么重要：注册顺序是有语义的——registry 的各 ArraySlot 保注册序，
//    消费侧对 `order` 平手的裁决是「后注册者胜出」（查找型槽位）或「后注册者靠后」（列表型）。
//    跨 source 的次序由 bootstrap 显式决定（builtin→installed→user→project），
//    但同一 source 内部若沿用文件系统枚举序，平手胜负就**跨机器不可复现**
//    （POSIX 不保证 readdir 顺序，APFS/ext4 各异，增删文件后还会变）。
describe("discoverPlugins：同一 source 内的顺序确定（按 id 字典序，与文件系统枚举序无关）", () => {
  it("乱序创建的插件目录，发现结果仍按 manifest.id 升序", () => {
    const root = mkdtempSync(join(tmpdir(), "mhd-discover-order-"));
    // 故意用非字典序创建（zebra 先、alpha 后），若实现依赖 readdir 顺序就会暴露
    for (const id of ["zebra", "mango", "alpha", "Beta"]) {
      const dir = join(root, id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "plugin.json"), JSON.stringify({ id, version: "1.0.0" }), "utf-8");
    }
    const found = discoverPlugins(root, "user").map((p) => p.manifest.id);
    expect(found, "发现顺序必须是 id 字典序（大写在前，因为按码点比较）").toEqual(["Beta", "alpha", "mango", "zebra"]);
  });

  it("递归下降时同样有序：深层目录里的插件也按 id 归位，不因所在目录而聚簇", () => {
    const root = mkdtempSync(join(tmpdir(), "mhd-discover-deep-"));
    // 两个域目录，各自含插件；域目录本身的枚举序不得影响最终 id 序
    const layout: [string, string][] = [
      ["sessions/zeta-plugin", "zeta"],
      ["sessions/aaa-plugin", "aaa"],
      ["project/mid-plugin", "mid"],
    ];
    for (const [rel, id] of layout) {
      const dir = join(root, rel);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "plugin.json"), JSON.stringify({ id, version: "1.0.0" }), "utf-8");
    }
    const found = discoverPlugins(root, "builtin").map((p) => p.manifest.id);
    expect(found).toEqual(["aaa", "mid", "zeta"]);
  });

  it("排序不得改变「发现了哪些插件」（只改次序，不改集合）", () => {
    const root = mkdtempSync(join(tmpdir(), "mhd-discover-set-"));
    const ids = ["p1", "p2", "p3"];
    for (const id of ids) {
      const dir = join(root, id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "plugin.json"), JSON.stringify({ id, version: "1.0.0" }), "utf-8");
    }
    // 混入两个应被跳过的：无 id 的 locale 资源、隐藏目录
    mkdirSync(join(root, ".hidden"), { recursive: true });
    writeFileSync(join(root, ".hidden", "plugin.json"), JSON.stringify({ id: "hidden" }), "utf-8");
    const localeDir = join(root, "i18n", "locales", "en");
    mkdirSync(localeDir, { recursive: true });
    writeFileSync(join(localeDir, "plugin.json"), JSON.stringify({ resources: {} }), "utf-8");
    const found = discoverPlugins(root, "user").map((p) => p.manifest.id);
    expect([...found].sort(), "集合必须与排序前一致（只改次序）").toEqual([...ids].sort());
    expect(found, "且仍是字典序").toEqual(["p1", "p2", "p3"]);
  });
});
