// 测试专用插件种子器 —— test-plugins/ 下的插件只有被"装进"隔离 HOME 才会装载。
//
// 为什么需要它（结构性理由，不是省事）：
//   ① `test-plugins/**` **不在任何生产扫描根里**（生产只扫 `src/plugins` = 内置、`<数据根>/plugins`
//      = 用户装、`<数据根>/installed` = 装过的包、`<cwd>/.my-harness-desktop/plugins` = 项目级）。
//      于是 minimal 这类内核**在日常使用中根本不存在** —— 不可能再出现"用一个测试开关造出一条
//      用户看不懂的 minimal 会话"那种幽灵数据。
//   ② 要测它，就把它种进隔离 HOME 的**用户插件目录**（`<数据根>/plugins/`）——这正是第三方内核
//      插件被装载的真实路径（`assemble.ts` 的 `scanKernelPlugins(userPluginsDir)`），
//      所以测试走的不是一条测试专供的旁路。
//   ③ 内核面（`plugin.js`）按**构建根约定**加载（`out/main/server/kernel/<id>/plugin.js`），
//      与插件目录无关；renderer 面走构建期 chunk 表（`src/web/app/plugins-host.ts` 的两个 glob）。
//      所以"种一个目录"就够了，不需要重构建。
import { cpSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
/** 仓库根（scripts/demo/lib → ../../..）。 */
const ROOT = resolve(HERE, "..", "..", "..");

/** 可种的测试专用插件 id（目录即白名单：test-plugins/kernels/<id>）。 */
export const TEST_KERNEL_IDS = ["minimal", "probe4"];

/**
 * 把 test-plugins/kernels/<id> 种进隔离 HOME 的用户插件目录。
 * @param {string} dataRoot 隔离数据根（`setupBaseline` 的 ctx.dataRoot）
 * @param {string[]} ids 要种的插件 id，缺省全部
 * @returns {string[]} 实际种下的目标目录
 */
export function seedTestPlugins(dataRoot, ids = TEST_KERNEL_IDS) {
  const out = [];
  for (const id of ids) {
    const src = join(ROOT, "test-plugins", "kernels", id);
    if (!existsSync(join(src, "plugin.json"))) {
      throw new Error(`测试专用插件不存在或没有 manifest: ${src}`);
    }
    const dest = join(dataRoot, "plugins", "kernels", id);
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest, { recursive: true });
    out.push(dest);
  }
  return out;
}

/** 摘掉种下的测试专用插件（模拟"卸载 = 删 plugin.json"的验收场景）。 */
export function removeTestPlugin(dataRoot, id) {
  rmSync(join(dataRoot, "plugins", "kernels", id), { recursive: true, force: true });
}
