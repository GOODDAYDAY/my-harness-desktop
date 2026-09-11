// 内核插件加载器(§kernel-plugin 物理插件) —— 扫描壳插件根目录里的**内核面声明** → 载入工厂 → register。
//
// 「一个内核 = 一个插件」（§目标 11/13）的落地形态：
//   内核本体(适配器/协议/spawn) 与 desktop 对接面(renderer/locales) 同属
//   `src/plugins/kernels/<id>/`，共用**同一份** plugin.json —— 内核面写在它的 `kernel` 块里。
//   所以本加载器不再扫一个专属的"内核插件目录"，而是扫**与壳插件相同的根目录**：
//   凡 manifest 带 `kernel` 块者，既是一个壳插件，也是一个内核插件。
//
// 这样做的三个直接收益（都是"两份定义"消失）：
//   ① 内核与其管理面不会各有一份 manifest（此前 src/server/kernel/<id>/plugin.json 与
//      src/plugins/manager/<id>-manager/plugin.json 并存，改一处忘一处）；
//   ② 卸载 = 删一个目录，内核与设置页同生共死（此前删内核插件后设置页还在，点进去全是报错）；
//   ③ 加第四个内核 = 加一个目录，装配点零改动。
//
// 加载方式：main 构建产物是 cjs，故用 createRequire 的同步 require 动态加载
// `<内核构建根>/<id>/plugin.js`（rollup 把各内核的 plugin.ts 独立打包到那里）。
// 同步加载让 assemble 无需改 async（modelCatalog 依赖 registry 已注册，须同步完成）。

import { readdirSync, existsSync, readFileSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { createRequire } from "node:module";
import type { KernelPluginContext, KernelPluginFactory, KernelPluginManifest, KernelPluginModule, PluginManifest } from "@my-harness-desktop/shared";
import type { KernelRegistry } from "./kernel-registry";

/** cjs 动态 require(相对本模块位置),加载编译产物 plugin.js。 */
const dynamicRequire = createRequire(import.meta.url);

/** 一条扫描到的内核插件:宿主壳插件目录 + 内核面声明。 */
export interface KernelPluginEntry {
  /** 宿主壳插件目录(内核与其对接面同属这里)。 */
  dir: string;
  manifest: KernelPluginManifest;
}

/**
 * 扫描**壳插件根目录**，返回「manifest 带 `kernel` 块」的插件清单（纯函数，可单测）。
 *
 * 递归形状与 `application/loader/discover.ts` 的 `discoverPlugins` 一致（`<域>/<插件>/plugin.json`，
 * 命中即止不再下探），这样同一个根目录既能喂内核加载器、也能喂壳插件发现，两边看到的是同一批目录。
 * 卸载 = 删某插件的 `plugin.json`（或整个目录），扫描即不再返回它——壳据此缺面降级，照常启动。
 */
export function scanKernelPlugins(pluginRootDir: string): KernelPluginEntry[] {
  if (!existsSync(pluginRootDir)) return [];
  const entries: KernelPluginEntry[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 3) return;
    for (const name of readdirSync(dir)) {
      if (name.startsWith(".") || name === "node_modules") continue;
      const sub = join(dir, name);
      let st;
      try {
        st = statSync(sub);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      const manifestPath = join(sub, "plugin.json");
      if (!existsSync(manifestPath)) {
        walk(sub, depth + 1);
        continue;
      }
      let parsed: PluginManifest;
      try {
        parsed = JSON.parse(readFileSync(manifestPath, "utf-8")) as PluginManifest;
      } catch {
        continue; // JSON 损坏：与壳插件发现同规则跳过（别处会报清楚）
      }
      if (typeof parsed.id !== "string" || !parsed.id) continue; // locale 资源等同名文件：非 manifest
      if (!parsed.kernel) continue; // 普通壳插件，不是内核插件
      // 内核 id 单源 = 壳插件 manifest 的 id（内核面块里不再重复写一遍）
      entries.push({ dir: sub, manifest: { ...parsed.kernel, id: parsed.id } });
    }
  };
  walk(pluginRootDir, 0);
  // 按 order 排序(越小越先注册 = 默认内核;缺省排最后,字母序)。
  entries.sort((a, b) => (a.manifest.order ?? 99) - (b.manifest.order ?? 99) || a.manifest.id.localeCompare(b.manifest.id));
  return entries;
}

/**
 * 默认装载清单(§目标 16):过滤 manifest.enabled === false 的内核(默认不装载),除非其 id 在
 * forceEnable 里(运行时环境变量 MHD_ENABLE_KERNELS 强制启用,测试/demo 用)。
 * 纯函数,可单测——「扫描 = 存在性」与「装载 = 默认开关」是两个正交概念,别混进 scanKernelPlugins。
 * 卸载语义仍是「删 manifest → 扫描不存在」,与 enabled 无关。
 */
export function defaultEnabledEntries(
  entries: KernelPluginEntry[],
  forceEnable: ReadonlySet<string> = new Set(),
): KernelPluginEntry[] {
  return entries.filter((e) => e.manifest.enabled !== false || forceEnable.has(e.manifest.id));
}

/** 内核工厂模块的绝对路径：显式 `factory` 按宿主插件目录解析，否则走构建根约定。 */
export function resolveKernelFactoryPath(entry: KernelPluginEntry, kernelBuildRoot: string): string {
  return entry.manifest.factory
    ? resolve(entry.dir, entry.manifest.factory)
    : join(kernelBuildRoot, entry.manifest.id, "plugin.js");
}

/** 同步加载单个内核插件:require 工厂模块,取工厂(default 优先,回落 `${id}KernelPlugin`),register。 */
export function loadKernelPlugin(
  registry: KernelRegistry,
  entry: KernelPluginEntry,
  kernelBuildRoot: string,
  ctx: KernelPluginContext,
): void {
  const factoryPath = resolveKernelFactoryPath(entry, kernelBuildRoot);
  if (!existsSync(factoryPath)) {
    throw new Error(
      `内核插件 ${entry.manifest.id} 的工厂产物不存在: ${factoryPath}` +
        `（构建未产出该内核入口？见 electron.vite.config.ts 的 rollup input 与 copy/构建脚本）`,
    );
  }
  const module = dynamicRequire(factoryPath) as KernelPluginModule;
  const factory = (module.default ?? module[`${entry.manifest.id}KernelPlugin`]) as KernelPluginFactory | undefined;
  if (typeof factory !== "function") {
    throw new Error(`内核插件 ${entry.manifest.id} 的工厂模块缺 default/${entry.manifest.id}KernelPlugin 导出: ${factoryPath}`);
  }
  registry.register(factory(ctx));
}
