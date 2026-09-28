// `plugins:list` 对「从未注册过的禁用插件」的兜底守卫。
//
// 守的是 boot-surface 阶段一那处**语义变化**的核心承诺（设计文档 §5.1.2 / §6.4.1）：
// 禁用插件从「先 registerAll 再逐个 unregister」改成「**根本不注册**」，而管理页的可见面
// 必须不变——插件仍要被列出、`state` 仍是 `inactive`、仍能重新启用。
//
// 承诺的落点是 `controllers/plugins.ts` 的第二段循环：对 `disabled` 与 `erroredPlugins()` 里
// **不在注册表**的 id 调 `rediscoverPlugin(id)` 从磁盘重扫。那段代码今天已经存在（原本是为
// `reportLoadFailure`（renderer 上报加载失败后撤注册）写的），恰好也覆盖"启动时就没注册"。
//
// 为什么必须有测试：这是"删掉一段启动逻辑、靠另一段既有逻辑兜住"的改动，兜底若失效，症状是
// **管理页里被禁用的插件直接消失**——用户无法再启用它（看不到就点不到），而且不报错。
// 属于典型的静默功能丢失，必须钉住。
//
// 全部用真实对象（真 PluginRegistry / 真 ConfigStore / 真磁盘上的 plugin.json），不用替身。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerPlugins } from "./plugins";
import { IPC } from "@my-harness-desktop/shared";
import { PluginRegistry } from "../application/loader/registry";
import { ConfigStore } from "../application/config/config-store";
import { discoverPlugins } from "../application/loader/discover";

let root: string;
let builtinDir: string;
let configDir: string;
const handlers = new Map<string, (...a: unknown[]) => unknown>();
const gateway = { register: (ch: string, h: (...a: unknown[]) => unknown) => { handlers.set(ch, h); }, broadcast: () => {} };

/** 在 builtin 根下造一个真实可被发现的插件（域分组一层，与内置仓库的真实形状一致）。 */
function writePlugin(id: string, extra: Record<string, unknown> = {}): string {
  const dir = join(builtinDir, "sessions", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plugin.json"), JSON.stringify({
    id, version: "1.0.0", displayName: `测试插件 ${id}`, ...extra,
  }, null, 2), "utf-8");
  return dir;
}

function makeCtx(registry: PluginRegistry) {
  const configStore = new ConfigStore({ userDir: configDir, getProjectDir: () => null });
  const paths = {
    homeDir: root,
    myHarnessDesktopDir: root,
    configDir,
    generalConfigPath: join(configDir, "general.json"),
    bundledSkillsDir: join(root, "skills"),
    bundledSkillsSource: join(root, "skills-src"),
    builtinDir,
    userPluginsDir: join(root, "user-plugins"),
    projectPluginsDir: join(root, "project-plugins"),
    installedDir: join(root, "installed"),
  };
  return { registry, configStore, paths, lifecycleDeps: {} } as never;
}

/** 写全局层配置 `{userDir}/{pluginId}.json`（ConfigStore 的落盘约定）。 */
function writeDisabled(list: string[]): void {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "plugin-manager.json"), JSON.stringify({ disabledPlugins: list }), "utf-8");
}

async function listPlugins(): Promise<{ id: string; state: string }[]> {
  const out = await handlers.get(IPC.plugins.list)!({}) as { id: string; state: string }[];
  return out;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "plugins-list-"));
  builtinDir = join(root, "builtin");
  configDir = join(root, "config");
  mkdirSync(builtinDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  handlers.clear();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("plugins:list 对「启动时就没注册」的禁用插件的兜底", () => {
  it("禁用插件不在注册表里，但仍被列出且 state=inactive（管理页可见面不变）", async () => {
    writePlugin("disabled-one");
    writePlugin("enabled-one");
    writeDisabled(["disabled-one"]);

    // 复现 40-shell-plugins 步骤的行为：只注册未禁用的（今天已改为"根本不注册"禁用的）
    const registry = new PluginRegistry();
    const disabled = new Set(["disabled-one"]);
    registry.registerAll(discoverPlugins(builtinDir, "builtin").filter((p) => !disabled.has(p.manifest.id)));
    expect(registry.manifestOf("disabled-one"), "前置：禁用插件确实没被注册").toBeUndefined();
    expect(registry.manifestOf("enabled-one")).toBeTruthy();

    registerPlugins(gateway as never, makeCtx(registry));
    const list = await listPlugins();
    const ids = list.map((p) => p.id).sort();

    expect(ids, "两个插件都要在管理页里出现").toEqual(["disabled-one", "enabled-one"]);
    expect(list.find((p) => p.id === "disabled-one")?.state, "禁用的显示 inactive").toBe("inactive");
    expect(list.find((p) => p.id === "enabled-one")?.state, "启用的显示 active").toBe("active");
  });

  it("兜底条目带齐管理页需要的字段（displayName/version/source/protected/contributes），不是只有 id 的空壳", async () => {
    writePlugin("disabled-rich", { description: "一段描述", protected: true, contributes: { settings: [] } });
    writeDisabled(["disabled-rich"]);

    const registry = new PluginRegistry();
    registerPlugins(gateway as never, makeCtx(registry));
    const list = await listPlugins();
    const item = list.find((p) => p.id === "disabled-rich") as Record<string, unknown> | undefined;

    expect(item, "禁用插件必须被列出").toBeTruthy();
    // 这些字段都来自 rediscoverPlugin 从磁盘重扫的 manifest；缺任何一个管理页就会渲染出空洞
    expect(item!.displayName).toBe("测试插件 disabled-rich");
    expect(item!.description).toBe("一段描述");
    expect(item!.version).toBe("1.0.0");
    expect(item!.source).toBe("builtin");
    expect(item!.protected).toBe(true);
    expect(item!.state).toBe("inactive");
  });

  it("磁盘上找不到的禁用 id 不进清单（不伪造一个不存在的插件）", async () => {
    writeDisabled(["ghost-plugin"]);
    const registry = new PluginRegistry();
    registerPlugins(gateway as never, makeCtx(registry));
    const list = await listPlugins();
    expect(list.map((p) => p.id)).not.toContain("ghost-plugin");
  });

  it("已注册的插件不会被兜底循环重复列出（两段循环不产生重复条目）", async () => {
    writePlugin("both-paths");
    writeDisabled([]);                       // 未禁用
    const registry = new PluginRegistry();
    registry.registerAll(discoverPlugins(builtinDir, "builtin"));
    registerPlugins(gateway as never, makeCtx(registry));
    const list = await listPlugins();
    expect(list.filter((p) => p.id === "both-paths").length, "同一插件只能出现一次").toBe(1);
  });
});
