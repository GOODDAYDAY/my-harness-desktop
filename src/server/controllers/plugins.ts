// IPC:插件生命周期管理(plugins.*)—— 注册/启停/卸载/安装/加载失败上报。
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Gateway } from "../routing/gateway";
import { discoverPlugins } from "../application/loader/discover";
import {
  activate, disablePlugin, enablePlugin, uninstallPlugin, reloadPlugin,
  getPluginState, reportLoadFailure, erroredPlugins,
  type PluginLifecycleDeps,
} from "../application/lifecycle";
import { install as installPlugin, UrlSource, LocalFileSource } from "../application/installer";
import type { PluginListItem, PluginManifest } from "@my-harness-desktop/shared";
import { resolvePluginTags } from "@my-harness-desktop/shared";
import { IPC } from "@my-harness-desktop/shared";
import { notifyPluginsChanged, notifyPluginUnloaded } from "../routing/broadcast";
import type { MainContext } from "../application/context/main-context";

export function registerPlugins(gateway: Gateway, ctx: MainContext): void {
  // `lifecycleDeps` 由组装根的 `50-wiring` 步骤构造并整体挂在 MainContext 上（§5.1.3）——
  // 冷启动的 `75-plugin-boot` 步骤与暖启动的 `lifecycle.activate`/`deactivate` 必须共用同一份
  // `skillsEnsure`/`pluginExtensionEnsure` 实现，否则就是同一逻辑在两个入口各写一遍（判别气味三）。
  // 此前本文件自己拼一份（见 git 历史里的 pluginLoader + lifecycleDeps 字面量），已上提。
  const { registry, configStore, paths, lifecycleDeps } = ctx;

  function rediscoverPlugin(pluginId: string): { manifest: PluginManifest; path: string; source: "builtin" | "user" | "installed" | "project" } | undefined {
    // 与启动发现同一条递归下降(按 manifest.id 匹配)。根因:旧码 join(dir, pluginId)
    // 平铺直查,而内置仓库按域分组(sessions/markdown 等多一层)——内置件卸载后
    // 装不回(enable/reload 永远 notFound)。复用 discoverPlugins 单源逻辑。
    const dirs: [string, "builtin" | "user" | "installed" | "project"][] = [
      [paths.projectPluginsDir, "project"],
      [paths.userPluginsDir, "user"],
      [paths.installedDir, "installed"],
      [paths.builtinDir, "builtin"],
    ];
    for (const [dir, src] of dirs) {
      const found = discoverPlugins(dir, src).find((d) => d.manifest.id === pluginId);
      if (found) return { manifest: found.manifest, path: found.path, source: src };
    }
    return undefined;
  }

  /** 插件 renderer 入口(磁盘形态)。
   *
   *  - 显式声明了 `manifest.renderer`:原样交出——文件缺失由 renderer 侧响亮失败,那是作者的错;
   *  - 缺省形状 `./renderer/index.js`:**只在文件真的存在时**才交。
   *
   *  为什么(根因,勿退回成无条件交缺省值):不存在的路径会被 renderer 侧当第三方插件去
   *  `import(file://…)`,失败后把插件记成 error 并**把 app 拖进错误态**(实测:一个 renderer
   *  只在构建期 chunk 里、磁盘上没有编译产物的内核插件,种上后 composer 直接起不来)。
   *  而"磁盘上没有 renderer"本身是**合法状态**:插件的界面可以来自构建期 chunk
   *  (`src/web/app/plugins-host.ts` 的 glob 表,随壳分发/测试专用插件都走这条),
   *  没有 renderer 的插件按"只有后端面/设置面来自 chunk"处理,不报错。 */
  function rendererEntryFor(pluginPath: string, manifest: PluginManifest): string | null {
    if (manifest.renderer) return manifest.renderer;
    return existsSync(join(pluginPath, "renderer", "index.js")) ? "./renderer/index.js" : null;
  }

  function inferTier(manifest: PluginManifest, _source: string): "official" | "verified" | "community" {
    // 无特权差异(§1.4):tier 由 manifest 声明,不按 source 自动赋级(避免"内置=official"特权)。
    // 未声明 tier 的插件统一 community(中性兜底),需特权的插件在 plugin.json 声明 "tier"。
    return manifest.tier ?? "community";
  }

  gateway.register(IPC.plugins.list, async () => {
    const disabled = (await configStore.get<string[]>("plugin-manager", "disabledPlugins")) ?? [];
    const list: PluginListItem[] = [];
    for (const [id, plugin] of registry.allPlugins()) {
      const isBuiltin = plugin.source === "builtin";
      list.push({
        id,
        displayName: plugin.manifest.displayName ?? id,
        description: plugin.manifest.description,
        version: plugin.manifest.version,
        source: plugin.source,
        tier: inferTier(plugin.manifest, plugin.source),
        state: getPluginState(id, disabled),
        protected: !!plugin.manifest.protected,
        path: isBuiltin ? null : plugin.path,
        renderer: isBuiltin ? null : rendererEntryFor(plugin.path, plugin.manifest),
        contributes: plugin.manifest.contributes,
        tags: resolvePluginTags(plugin.manifest),
      });
    }
    // disabled + error(renderer 上报加载失败被撤注册)：不在注册表里的也要列出供管理页展示，
    // state 由 getPluginState 判定(error 优先于 inactive)——加载失败是可见的一等状态，不再静默消失。
    for (const id of new Set([...disabled, ...erroredPlugins()])) {
      if (!registry.manifestOf(id)) {
        const discovered = rediscoverPlugin(id);
        if (discovered) {
          const isBuiltin = discovered.source === "builtin";
          list.push({
            id,
            displayName: discovered.manifest.displayName ?? id,
            description: discovered.manifest.description,
            version: discovered.manifest.version,
            source: discovered.source,
            tier: inferTier(discovered.manifest, discovered.source),
            state: getPluginState(id, disabled),
            protected: !!discovered.manifest.protected,
            path: isBuiltin ? null : discovered.path,
            renderer: isBuiltin ? null : rendererEntryFor(discovered.path, discovered.manifest),
            contributes: discovered.manifest.contributes,
            tags: resolvePluginTags(discovered.manifest),
          });
        }
      }
    }
    return list;
  });

  gateway.register(IPC.plugins.enable, async (_e, pluginId: string) => {
    return enablePlugin(lifecycleDeps, pluginId, () => rediscoverPlugin(pluginId));
  });

  gateway.register(IPC.plugins.disable, async (_e, pluginId: string) => {
    return disablePlugin(lifecycleDeps, pluginId);
  });

  gateway.register(IPC.plugins.uninstall, async (_e, pluginId: string) => {
    return uninstallPlugin(lifecycleDeps, pluginId);
  });

  gateway.register(IPC.plugins.reload, async (_e, pluginId: string) => {
    return reloadPlugin(lifecycleDeps, pluginId, () => rediscoverPlugin(pluginId));
  });

  // renderer 上报插件 renderer 模块加载失败：撤注册 + 记 error + 广播（与 activate 失败分支同出口）。
  gateway.register(IPC.plugins.loadFailed, (_e, pluginId: string) => {
    reportLoadFailure(lifecycleDeps, pluginId);
  });

  gateway.register(IPC.plugins.install, async (_e, source: { type: "url" | "local"; location: string }) => {
    const installSource = source.type === "url"
      ? new UrlSource(source.location)
      : new LocalFileSource(source.location);
    const result = await installPlugin(installSource, paths.installedDir);
    if (!result.ok || !result.manifest || !result.pluginPath) return result;
    return activate(lifecycleDeps, result.manifest, result.pluginPath, "installed");
  });
}
