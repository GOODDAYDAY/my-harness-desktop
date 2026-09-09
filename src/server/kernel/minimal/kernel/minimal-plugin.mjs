// minimal 插件系统 —— 可拆分的独立模块(零壳依赖)。
//
// 依据 docs/design/minimal-kernel.md §6。插件是 <agentDir>/plugins/*.mjs,各导出一个
// register(host)。host 是 MinimalPluginHost 接口面(§6.2.3):registerTool/unregisterTool/
// on/registerCommand/getConfig。插件系统只 import 工具注册表接口(minimal-tools),不 import
// 内核本体其它内部——依赖方向干净,将来拆成独立项目只需挪这个文件 + 接口面。

import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { registerTool, unregisterTool } from "./minimal-tools.mjs";

/** 插件生命周期事件监听(§6.3.2 的 on):跨插件共享一份注册表,CLI 在关键事件点分发。 */
const lifecycleListeners = new Map();

/** 插件命令注册表(§6.3.2 的 registerCommand):跨插件共享,CLI 的 unknown 命令分发到这。 */
const commandRegistry = new Map();

/** 插件注册/卸载工具(§6.3.1):插件的 schema + run 进内核注册表,与内置同构。 */
function registerPluginTool(schema, run) {
  registerTool(schema.name, {
    name: schema.name,
    description: schema.description,
    grade: "extension",
    parameters: schema.parameters,
    run,
  });
}

/** 构造一个插件 host(§6.2.3 接口面)。on 订阅生命周期事件,registerCommand 注册命令,
 *  getConfig 读插件自己的配置(§6.10,落在 <agentDir>/plugins/<pluginId>.config.json)。 */
export function createPluginHost(agentDir, pluginId) {
  return {
    registerTool: registerPluginTool,
    unregisterTool,
    on: (event, handler) => {
      if (!lifecycleListeners.has(event)) lifecycleListeners.set(event, new Set());
      lifecycleListeners.get(event).add(handler);
      return () => lifecycleListeners.get(event)?.delete(handler);
    },
    registerCommand: (name, handler) => {
      commandRegistry.set(name, handler);
    },
    getConfig: () => {
      const p = join(agentDir, "plugins", `${pluginId}.config.json`);
      if (!existsSync(p)) return {};
      try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return {}; }
    },
  };
}

/** 分发一个 unknown 命令给插件(§6.3.2)。命中返回 true,未命中 false(CLI 报 unknown)。 */
export function dispatchCommand(name, args) {
  const h = commandRegistry.get(name);
  if (!h) return false;
  try { h(args); } catch (e) { console.error(`[minimal-plugin] 命令 ${name} 抛错:`, e instanceof Error ? e.message : String(e)); }
  return true;
}

/** 分发一个生命周期事件给所有订阅的插件(§6.3.2)。CLI 在 agentSettled 等关键点调。 */
export function dispatchPluginEvent(event, payload) {
  for (const h of [...(lifecycleListeners.get(event) ?? [])]) {
    try { h(payload); } catch (e) { console.error(`[minimal-plugin] ${event} 监听抛错:`, e instanceof Error ? e.message : String(e)); }
  }
}

/** 加载 <agentDir>/plugins/*.mjs 的插件(§6.9 目录扫描)。返回已加载的插件文件名。 */
export async function loadPlugins(agentDir) {
  const dir = join(agentDir, "plugins");
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".mjs"));
  } catch {
    return []; // 无插件目录。
  }
  const loaded = [];
  for (const f of files) {
    try {
      const mod = await import(pathToFileURL(join(dir, f)).href);
      if (typeof mod.register === "function") {
        const pluginId = f.replace(/\.mjs$/, "");
        await mod.register(createPluginHost(agentDir, pluginId));
        loaded.push(f);
      }
    } catch (e) {
      console.error(`[minimal-plugin] 插件 ${f} 加载失败:`, e instanceof Error ? e.message : String(e));
    }
  }
  return loaded;
}
