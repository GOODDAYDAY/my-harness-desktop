// 插件 ↔ 插件文档的一一对应守卫(静态,零 IO)。
//
// 依据:CLAUDE.md「文档先行」+ 用户要求「文件是否对应」。实测当前是**精确 1:1**
// (50 个壳插件 ↔ 50 份同名文档),但此前**没有任何东西在守它**——加一个插件忘了写文档,
// 或者删了插件留下孤儿文档,都不会有任何信号。
//
// 判据:插件取 `src/plugins/<域>/<名>/plugin.json` 的**末段名**(域是有意不参与比较的:
// 文档目录是扁平的 `docs/plugins/**`);文档取 `docs/plugins/**/*.md` 的 basename。
// 两个集合必须**相等**(不是包含)——多了少了都算违规,并在失败信息里列出是哪边多了哪些。
import { readdirSync, statSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 壳插件名:深度恰为 `src/plugins/<域>/<名>/plugin.json`,取 <名>。
 *  这个深度约束是**实测得出的**:`plugin.json` 在仓里有两个深度——
 *  深度 3 是壳插件(50 个),深度 4 是内核扩展子 manifest(`<名>/pi-extension/plugin.json`,88 个)。
 *  把两者混在一起数会得到 138,那不是"插件数"。 */
function shellPluginNames(): string[] {
  const names: string[] = [];
  // 两个插件根:src/plugins(随壳分发)与 test-plugins(测试专用插件,如 minimal 内核插件)。
  // 测试专用插件同样要"有插件必有文档"——它的读者正是加第四个内核的人,反而更该有文档。
  for (const root of ["src/plugins", "test-plugins"]) {
    const rootDir = join(ROOT, root);
    if (!statSync(rootDir).isDirectory()) continue;
    for (const domain of readdirSync(rootDir)) {
      const domainDir = join(rootDir, domain);
      if (!statSync(domainDir).isDirectory()) continue;
      for (const name of readdirSync(domainDir)) {
        const manifest = join(domainDir, name, "plugin.json");
        try {
          if (statSync(manifest).isFile()) names.push(name);
        } catch {
          // 没有 manifest 的目录(如 locales/、共享工具目录)不参与比较
        }
      }
    }
  }
  return [...new Set(names)].sort();
}

function pluginDocNames(): string[] {
  const names: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (entry.endsWith(".md")) names.push(basename(entry, ".md"));
    }
  };
  walk(join(ROOT, "docs/plugins"));
  return [...new Set(names)].sort();
}

describe("插件 ↔ 文档一一对应", () => {
  const plugins = shellPluginNames();
  const docs = pluginDocNames();

  it("两侧都非空(判据本身不空转)", () => {
    expect(plugins.length).toBeGreaterThan(0);
    expect(docs.length).toBeGreaterThan(0);
  });

  it("每个壳插件都有同名文档", () => {
    const missing = plugins.filter((n) => !docs.includes(n));
    expect(missing, `缺文档的插件: ${missing.join(", ")}`).toEqual([]);
  });

  it("每份插件文档都有同名插件(无孤儿文档)", () => {
    const orphan = docs.filter((n) => !plugins.includes(n));
    expect(orphan, `孤儿文档: ${orphan.join(", ")}`).toEqual([]);
  });
});
