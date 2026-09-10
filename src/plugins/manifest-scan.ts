// 插件 manifest 静态扫描(测试共用)——「递归找出所有 plugin.json 目录」只此一处。
//
// 为什么单独成模块:静态守卫(manifest 组件对账 / sidebar 槽拓扑)是同一类工作——
// 都要遍历全插件 manifest 再断言不变量。此前每个守卫各写一遍目录遍历,是 §1.1
// 判别气味三(同一逻辑在多个入口各写一遍)的形态;收敛到这里,守卫只写断言。
// 只在测试里 import(不参与运行时加载链),故允许直连 node:fs。
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** 插件 manifest 里本文件用得到的字段(形状与 packages/shared 的 PluginManifest 一致)。 */
export interface ScannedManifest {
  id: string;
  contributes?: Record<string, unknown>;
  [k: string]: unknown;
}

/** 递归找所有 plugin.json 所在目录(i18n 语言资源里的 plugin.json 无 id,被滤掉)。 */
export function* walkPluginDirs(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (!statSync(p).isDirectory()) continue;
    if (existsSync(join(p, "plugin.json"))) {
      try {
        const m = JSON.parse(readFileSync(join(p, "plugin.json"), "utf-8")) as { id?: unknown };
        if (typeof m.id === "string" && m.id) { yield p; continue; }
      } catch { /* 损坏 manifest 由 loader 侧报 */ }
    }
    yield* walkPluginDirs(p);
  }
}

/** 读一个插件目录的 manifest(调用方保证该目录由 walkPluginDirs 产出,故解析容错收敛于此)。 */
export function readManifest(dir: string): ScannedManifest {
  return JSON.parse(readFileSync(join(dir, "plugin.json"), "utf-8")) as ScannedManifest;
}
