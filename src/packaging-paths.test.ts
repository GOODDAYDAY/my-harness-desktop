// 打包路径存在性守卫（静态门）。
//
// 动机是一次**真实且隐蔽的漂移**：`electron-builder.yml` 的 `extraResources` 里有一条
// `from: src/client/dsh/dsh-extension`，而该目录在「前后端分离」搬迁后早已变成
// `src/server/kernel/dsh/extension/dsh-extension`。这条配置**不会报错**——打包时 electron-builder
// 对不存在的 from 只是不拷，于是安装包里**没有 dsh 扩展**；而 dev 态的路径是对的，
// 所以本地怎么跑都正常，只有真装一次才可能发现（而且症状是"某个功能在安装版里没有"，
// 极难归因）。同类风险还有：重命名目录后忘了改这里、把 from 写成相对路径的另一种拼法。
//
// 判据两侧都从配置派生，不写手写清单：
//   ① 从 electron-builder.yml 解析出所有 extraResources[].from；
//   ② 断言每个都指向仓库里**真实存在的路径**；
//   ③ 断言 to: 目标唯一（两条规则写同一个 to 会静默互相覆盖，比缺一条更难查）。
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { parse } from "yaml";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

interface BuilderConfig {
  extraResources?: { from?: string; to?: string; filter?: string[] }[];
}

function config(): BuilderConfig {
  return parse(readFileSync(join(ROOT, "electron-builder.yml"), "utf-8")) as BuilderConfig;
}

describe("electron-builder extraResources 的 from: 必须指向真实路径", () => {
  const entries = config().extraResources ?? [];

  it("判据本身不空转（确实解析出了 extraResources）", () => {
    expect(entries.length, "electron-builder.yml 里没解析到 extraResources，判据失效").toBeGreaterThan(0);
  });

  it("每条 from 都在仓库里存在（不存在 = 打包静默漏资产）", () => {
    // from 是源路径，必须带仓库相对路径（写绝对路径会让配置脱离仓库、无法校验）
    const bad = entries
      .map((e) => e.from ?? "")
      .filter((from) => !from || from.startsWith("/") || !existsSync(join(ROOT, from)));
    expect(
      bad,
      `extraResources.from 指向不存在的路径（打包不会报错，只会静默漏掉这些资产，装出来的包缺功能）: ${bad.join(", ")}`,
    ).toEqual([]);
  });

  it("to: 目标唯一（两条规则同 to 会静默互相覆盖）", () => {
    const targets = entries.map((e) => e.to ?? "").filter(Boolean);
    const dup = targets.filter((t, i) => targets.indexOf(t) !== i);
    expect(dup, `重复的 extraResources.to（后者静默覆盖前者）: ${dup.join(", ")}`).toEqual([]);
  });
});
