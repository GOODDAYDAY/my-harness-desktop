/**
 * 内核扩展入口发现 —— 壳子统一层。
 *
 * pi 和 dsh 两个内核的插件入口都是"扫目录找入口文件"，但历史上散在两处：pi 底座自己扫
 * （scanExtDir 找 index.ts/src/index.ts/index.js），dsh 靠壳子扫 .mjs 填 cordis.yml。
 * 本文件把"扫目录找入口"收敛到壳子一层：pi 侧壳子扫 .ts/.js 生成 package.json 声明，
 * dsh 侧壳子扫 .mjs 写 cordis.yml —— 两个底座都改为"被壳子声明"，发现逻辑单一来源。
 *
 * 依赖只向内：client 层纯工具，只用 node 内建模块，零依赖。
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * 递归扫描扩展目录，确定入口文件。
 * 规则：优先 `index.<ext>`，否则字典序第一个匹配扩展名的文件。
 * @param sourceDir 扩展目录（绝对路径）。
 * @param extensions 入口文件扩展名（含点，如 [".ts", ".js"] 或 [".mjs"]）。
 * @returns 入口文件相对 sourceDir 的路径（POSIX 分隔），如 "index.mjs" 或 "extension/index.ts"；无则 undefined。
 */
export function findExtensionEntry(sourceDir: string, extensions: string[]): string | undefined {
  const found: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, rel);
      } else if (entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext))) {
        found.push(rel);
      }
    }
  };
  walk(sourceDir, "");
  if (found.length === 0) return undefined;
  const indexFile = found.find((f) => extensions.some((ext) => f.endsWith(`index${ext}`)));
  return indexFile ?? found[0];
}
