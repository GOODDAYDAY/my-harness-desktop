// 插件发现(最小)—— application 层,扫描插件目录取 manifest。
//
// 依据 docs/modules/04 §18.1(discover)与 structure/16 §18.1。
// 现状:扫描 + 读 manifest + 形态校验(id 非空);tokenSchemaVersion 校验与覆盖去重均在 registry;
// worker/热重载在 lifecycle 层(registerOne/unregister 与本模块的 discover 配套)。
// 内置与第三方平等:同一扫描逻辑,无 if(builtin) 分支(01-core:1447)。
// source 标记由目录归属判定(<cwd>/.my-harness-desktop/plugins/→project、~/.my-harness-desktop/plugins/
// →user、~/.my-harness-desktop/installed/→installed、随壳 builtin 目录→builtin)。
// shell 注入四目录循环 discoverPlugins 填注册表,按优先级注册(project>user>installed>builtin)。
//
// application 不 import electron:扫描根目录由 shell 注入,不在此调 resourcesPath。
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { PluginManifest } from "@my-harness-desktop/shared";

export interface DiscoveredPlugin {
  manifest: PluginManifest;
  /** 插件根目录绝对路径 */
  path: string;
  source: "project" | "user" | "installed" | "builtin";
}

/**
 * 扫描一个根目录下的所有插件,返回发现的插件列表。
 * 递归下降:目录含 plugin.json 且 manifest 形态合法(有 id)即插件,不再深入;
 * 否则继续向下找(内置仓库按域分组 themes/sessions/project/... 多一层;
 * i18n/locales/<lang>/plugin.json 是语言资源文件、无 id 字段,被形态校验自然滤掉)。
 * 第三方目录保持平铺,递归对平铺是退化的(第一层即命中)。
 */
export function discoverPlugins(rootDir: string, source: DiscoveredPlugin["source"]): DiscoveredPlugin[] {
  const out: DiscoveredPlugin[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 3 || !existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith(".") || entry === "node_modules") continue;
      const sub = join(dir, entry);
      let st;
      try {
        st = statSync(sub);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      const manifestFile = join(sub, "plugin.json");
      if (existsSync(manifestFile)) {
        // plugin.json 所在目录是终点:合法则收为插件,损坏或非 manifest
        // (locale 资源等无 id 字段)则跳过——两种都不深入其子目录,不拖垮扫描。
        try {
          const manifest = JSON.parse(readFileSync(manifestFile, "utf-8")) as PluginManifest;
          if (typeof manifest.id === "string" && manifest.id.length > 0) {
            out.push({ manifest, path: sub, source });
          }
        } catch {
          // JSON 损坏,按上注释同规则跳过
        }
        continue;
      }
      walk(sub, depth + 1);
    }
  };
  walk(rootDir, 0);
  // ⚠ **必须排序**（r70）：注册顺序是有语义的——registry 的各 ArraySlot 保注册序，
  //   而消费侧对 `order` 平手的裁决是「后注册者胜出」（查找型槽位）或「后注册者靠后」（列表型槽位）。
  //   跨 source 的次序由调用方显式决定（builtin → installed → user → project，
  //   见 bootstrap/boot/steps/40-shell-plugins.ts），但**同一 source 内部**此前直接沿用
  //   `readdirSync` 的枚举序——那是文件系统实现细节（POSIX 不保证任何顺序，APFS/ext4 各不相同，
  //   且增删文件后会变），于是：
  //     · 查找型槽位的平手胜负**跨机器不可复现**；
  //     · 列表型槽位里 `order` 相同的条目，其**显示先后**也是文件系统说了算。
  //   实测（r70）有 6 组落在后一种情况：sidePanel 的 order=15/40/60、settings 的 order=1/2、
  //   fileActions 的 order=100——这些组内谁先谁后，此前没有任何人决定过。
  //   按 `manifest.id` 字典序排序后，同一 source 内的次序变成**确定、可复现、可写进文档**的：
  //   「同 source、同 order ⇒ 插件 id 字典序小者在前」。跨 source 优先级不受影响。
  out.sort((a, b) => (a.manifest.id < b.manifest.id ? -1 : a.manifest.id > b.manifest.id ? 1 : 0));
  return out;
}
