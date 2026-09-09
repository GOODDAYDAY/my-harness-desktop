// 内核插件加载器(§kernel-plugin 物理插件) —— 扫描内核插件目录 → 读 manifest → 动态加载
// 工厂模块 → register 进 KernelRegistry。这是「内核插件可插拔」的机制面:
// 加第四个内核 = 加一个插件目录 + 一个 plugin.json;卸载 = 删目录/禁 manifest,壳照常启动。
//
// 加载方式:main 构建产物是 cjs,故用 createRequire 的同步 require 动态加载 plugin.js
// (rollup 把各 plugin.ts 独立打包成 out/main/server/kernel/{kernel}/plugin.js)。
// 同步加载让 assemble 无需改 async(modelCatalog 依赖 registry 已注册,须同步完成)。

import { readdirSync, existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createRequire } from "node:module";
import type { KernelPluginContext, KernelPluginFactory, KernelPluginManifest, KernelPluginModule } from "@my-harness-desktop/shared";
import type { KernelRegistry } from "./kernel-registry";

/** cjs 动态 require(相对本模块位置),加载编译产物 plugin.js。 */
const dynamicRequire = createRequire(import.meta.url);

/** 一条扫描到的内核插件:目录 + manifest。 */
export interface KernelPluginEntry {
  dir: string;
  manifest: KernelPluginManifest;
}

/**
 * 扫描内核插件根目录,返回「有 plugin.json 的子目录」清单(纯函数,可单测)。
 * 卸载 = 删某子目录的 plugin.json(或整个目录),扫描即不再返回它——壳据此缺面降级,照常启动。
 */
export function scanKernelPlugins(pluginRootDir: string): KernelPluginEntry[] {
  if (!existsSync(pluginRootDir)) return [];
  const entries: KernelPluginEntry[] = [];
  for (const name of readdirSync(pluginRootDir)) {
    const dir = join(pluginRootDir, name);
    const manifestPath = join(dir, "plugin.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as KernelPluginManifest;
    entries.push({ dir, manifest });
  }
  // 按 order 排序(越小越先注册 = 默认内核;缺省排最后,字母序)。
  entries.sort((a, b) => (a.manifest.order ?? 99) - (b.manifest.order ?? 99) || a.manifest.id.localeCompare(b.manifest.id));
  return entries;
}

/** 同步加载单个内核插件:require 工厂模块,取工厂(default 优先,回落 `${id}KernelPlugin`),register。 */
export function loadKernelPlugin(
  registry: KernelRegistry,
  pluginDir: string,
  manifest: KernelPluginManifest,
  ctx: KernelPluginContext,
): void {
  const factoryPath = resolve(pluginDir, manifest.factory);
  const module = dynamicRequire(factoryPath) as KernelPluginModule;
  const factory = (module.default ?? module[`${manifest.id}KernelPlugin`]) as KernelPluginFactory | undefined;
  if (typeof factory !== "function") {
    throw new Error(`内核插件 ${manifest.id} 的工厂模块缺 default/${manifest.id}KernelPlugin 导出: ${factoryPath}`);
  }
  registry.register(factory(ctx));
}
