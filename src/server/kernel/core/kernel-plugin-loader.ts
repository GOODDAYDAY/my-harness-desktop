// 内核插件加载器(§kernel-plugin 物理插件) —— 扫描壳插件根目录里的**内核面声明** → 载入工厂 → register。
//
// 「一个内核 = 一个插件」（§目标 11/13）的落地形态：
//   内核本体(适配器/协议/spawn) 与 desktop 对接面(renderer/locales) 同属
//   `src/plugins/kernels/<id>/`，共用**同一份** plugin.json —— 内核面写在它的 `kernel` 块里。
//   测试专用内核插件放 `test-plugins/kernels/<id>/`（**不在生产扫描根里**，只有测试把它种进
//   隔离 HOME 的用户插件目录才会装载——见 scripts/demo/lib/test-plugins.mjs）。
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
  /** 宿主壳插件 manifest **顶层** version（不是 `kernel` 块里的）。
   *  差量重载的判据之一：`(id, version)` 才认得出"同一个内核被改了"——只比 id 的话，
   *  改了代码/manifest 的内核会落进"两边都有 → 不动"分支，工厂不重跑、改动不生效
   *  （boot-surface.md §3.6.2）。缺 version 时退化为 `"0.0.0"`：宁可让差量判定偏保守
   *  （认为没变），也不要因为读不到版本就把整个重载做成"全部重装"。 */
  version: string;
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
      entries.push({
        dir: sub,
        manifest: { ...parsed.kernel, id: parsed.id },
        // 顶层 version：`plugin.json` 的 `version` 字段（pi 0.9.0 / dsh 0.1.0 / minimal 0.1.0）
        version: typeof parsed.version === "string" && parsed.version ? parsed.version : "0.0.0",
      });
    }
  };
  walk(pluginRootDir, 0);
  // 按 order 排序(越小越先注册,只决定清单/展示次序;缺省排最后,字母序)。
  // **这个顺序不是「默认内核」**:壳不拿谁排第一当兜底(设计原则 22)。
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
  const plugin = factory(ctx);
  // ⚠ **内核 id 单源校验**（r17 补；此前无守卫）。id 有两个来源：扫描侧的
  //   `entry.manifest.id`（宿主壳插件 manifest 顶层）与工厂返回的 `plugin.id`。
  //   注册表按**后者**存键，而差量重载、设置页挂载、renderer 的 TAB 都按**前者**查——
  //   两者不一致时：① 冷启动下内核"看起来没装载"（其实装载在另一个名字下）；
  //   ② 暖重载下 `registry.has(entry.manifest.id)` 永远 false，于是每次都判为"新增"、
  //     `register` 撞重复 id 抛错、进 errors —— **重载永远修不好自己**，且每点一次报一次。
  //   这是典型的静默漂移（没有任何一处会主动报错），所以在这里 fail-fast。
  //   依据：docs/design/kernel-plugin.md「内核 id 单源 = 壳插件 manifest 的 id」。
  if (plugin.id !== entry.manifest.id) {
    throw new Error(
      `内核插件 id 不一致: manifest 声明 "${entry.manifest.id}"，工厂返回 "${plugin.id}"` +
        `（${factoryPath}）。内核 id 以宿主 manifest 为单源，工厂不得另立一个 id。`,
    );
  }
  registry.register(plugin, entry.version);
}
