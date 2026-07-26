// 插件发现(最小)—— application 层,扫描插件目录取 manifest。
//
// 依据 docs/modules/04 §18.1(discover)与 structure/16 §18.1。
// 本次最小集:只做"扫描 + 读 manifest",不做校验/合并优先级/worker/热重载。
// 内置插件与第三方插件平等:同一扫描逻辑,无 if(builtin) 分支(01-core:1447)。
// source 标记由目录归属判定(<cwd>/.pi-desktop/plugins/→project、~/.pi-desktop/plugins/
// →user、~/.pi-desktop/installed/→installed、随壳 builtin 目录→builtin)。
// shell 注入四目录循环 discoverPlugins 填注册表,按优先级注册(project>user>installed>builtin)。
//
// application 不 import electron:扫描根目录由 shell 注入,不在此调 resourcesPath。
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { PluginManifest } from "../../domain/contributions";

export interface DiscoveredPlugin {
  manifest: PluginManifest;
  /** 插件根目录绝对路径 */
  path: string;
  source: "project" | "user" | "installed" | "builtin";
}

/**
 * 扫描一个根目录下的所有插件子目录,返回发现的插件列表。
 * 每个子目录里有 plugin.json 即算一个插件(04 §18.1.1:只一层,不递归)。
 */
export function discoverPlugins(rootDir: string, source: DiscoveredPlugin["source"]): DiscoveredPlugin[] {
  if (!existsSync(rootDir)) return [];
  const out: DiscoveredPlugin[] = [];
  for (const entry of readdirSync(rootDir)) {
    const dir = join(rootDir, entry);
    let st;
    try {
      st = statSync(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const manifestFile = join(dir, "plugin.json");
    if (!existsSync(manifestFile)) continue;
    try {
      const manifest = JSON.parse(readFileSync(manifestFile, "utf-8")) as PluginManifest;
      out.push({ manifest, path: dir, source });
    } catch {
      // 损坏 manifest 跳过,不拖垮(后续校验阶段记诊断)
    }
  }
  return out;
}
