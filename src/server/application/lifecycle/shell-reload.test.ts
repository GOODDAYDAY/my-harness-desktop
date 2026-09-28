// 壳插件差量重扫测试（`shell-reload.ts`，boot-surface.md §6.4.3 验收① 的前置缺口）。
//
// 为什么必须真目录 + 真注册表：本函数的判据全在"目录里现在有什么"与"注册表里现在有什么"
// 的**差**上。用替身伪造 `discoverPlugins` 的返回值，就把要验的东西假设掉了——
// 那正是 §17.2 说的"判据逻辑对、扫描范围空"的变体。所以这里只有 configStore / loader /
// 通知回调是最小替身（它们不参与差量判定），发现与注册走真实现。
//
// 守的是五条：① 新目录被拾起；② 消失的目录被摘掉；③ **内核面未装载的内核插件不注册**
// （与冷启动 `40-shell-plugins` 的同名过滤逐字对应）；④ 禁用插件不注册；
// ⑤ 两边都有的原样保留（不重跑 activate——`registerOne` 对 `languages` 槽**没有去重**，
// 重复注册会让语言贡献翻倍，所以"不动"不是优化而是正确性要求）。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reloadShellPlugins, type ShellPluginRoots } from "./shell-reload";
import { PluginRegistry } from "../loader/registry";
import type { PluginLifecycleDeps } from "./index";
import type { PluginManifest } from "@my-harness-desktop/shared";

let root: string;
let roots: ShellPluginRoots;

/** 在某一根下写一个插件目录（`<根>/<域>/<插件>/plugin.json`，与 discoverPlugins 的递归形状一致）。 */
function writePlugin(which: keyof ShellPluginRoots, domain: string, id: string, extra: Partial<PluginManifest> = {}): string {
  const dir = join(roots[which], domain, id);
  mkdirSync(dir, { recursive: true });
  const manifest: PluginManifest = { id, version: "1.0.0", contributes: {}, ...extra } as PluginManifest;
  writeFileSync(join(dir, "plugin.json"), JSON.stringify(manifest));
  return dir;
}

function removePlugin(which: keyof ShellPluginRoots, domain: string, id: string): void {
  rmSync(join(roots[which], domain, id), { recursive: true, force: true });
}

let notified = 0;
let unloaded: string[] = [];
let disabledList: string[] = [];
let registry: PluginRegistry;
let deps: PluginLifecycleDeps;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "shell-reload-"));
  roots = {
    builtin: join(root, "builtin"),
    installed: join(root, "installed"),
    user: join(root, "user"),
    project: join(root, "project"),
  };
  for (const r of Object.values(roots)) mkdirSync(r, { recursive: true });
  notified = 0;
  unloaded = [];
  disabledList = [];
  registry = new PluginRegistry();
  deps = {
    registry,
    configStore: {
      get: async (_ns: string, key: string) => (key === "disabledPlugins" ? disabledList : undefined),
      set: async () => {},
    },
    // main 侧 loader 是 no-op（renderer 自己加载 module），与 50-wiring 的装配一致
    loader: { load: async () => {}, unload: () => {} },
    notifyPluginsChanged: () => { notified += 1; },
    notifyPluginUnloaded: (id: string) => { unloaded.push(id); },
  } as unknown as PluginLifecycleDeps;
});

afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const reload = (kernelLoaded: string[] = []) =>
  reloadShellPlugins(deps, roots, (id, hasKernelBlock) => !hasKernelBlock || kernelLoaded.includes(id));

describe("reloadShellPlugins：把注册表收敛到「当前应当装载的集合」", () => {
  it("① 新出现的目录被拾起（这是此前**完全没有入口**的能力）", async () => {
    const r0 = await reload();
    expect(r0.activated).toEqual([]);
    expect(r0.changed).toBe(false);

    writePlugin("user", "sessions", "newcomer");
    const r1 = await reload();
    expect(r1.activated, "新目录必须被激活").toEqual(["newcomer"]);
    expect(r1.changed).toBe(true);
    expect(registry.allPlugins().has("newcomer")).toBe(true);
    expect(notified, "activate 自己会广播 plugins:changed").toBeGreaterThan(0);
  });

  it("② 目录消失 → 摘掉（deactivate + unregister + 点名广播）", async () => {
    writePlugin("user", "sessions", "gone");
    await reload();
    expect(registry.allPlugins().has("gone")).toBe(true);
    unloaded = [];

    removePlugin("user", "sessions", "gone");
    const r = await reload();
    expect(r.deactivated).toEqual(["gone"]);
    expect(registry.allPlugins().has("gone"), "注册表里必须真的没了（否则贡献项残留成孤儿 Tab）").toBe(false);
    expect(unloaded).toEqual(["gone"]);
  });

  it("③ 内核面未装载的内核插件**不注册**（与冷启动 40-shell-plugins 的过滤逐字对应）", async () => {
    // manifest.kernel 存在 = 这是个内核插件；它的内核没装载时，注册它只会让设置页
    // 出现一个点进去全是报错的 TAB。
    writePlugin("user", "kernels", "kimi", { kernel: { order: 1 } } as never);
    const r = await reload([]);                       // 没有任何内核装载
    expect(r.activated, "内核未装载 → 不注册").toEqual([]);
    expect(registry.allPlugins().has("kimi")).toBe(false);

    const r2 = await reload(["kimi"]);                // 内核装载了
    expect(r2.activated, "内核装载后下一次重扫就该拾起它").toEqual(["kimi"]);
    expect(registry.allPlugins().has("kimi")).toBe(true);
  });

  it("③' 反向：内核被卸载后，它的壳插件面也要被摘掉（不能留着报错 TAB）", async () => {
    writePlugin("user", "kernels", "kimi", { kernel: { order: 1 } } as never);
    await reload(["kimi"]);
    expect(registry.allPlugins().has("kimi")).toBe(true);

    const r = await reload([]);                       // 内核没了（目录还在）
    expect(r.deactivated, "目录还在但内核面不可装载 → 仍要摘掉").toEqual(["kimi"]);
    expect(registry.allPlugins().has("kimi")).toBe(false);
  });

  it("④ 被禁用的插件不注册；解禁后下一次重扫拾起", async () => {
    writePlugin("user", "insight", "off-one");
    disabledList = ["off-one"];
    const r = await reload();
    expect(r.activated).toEqual([]);
    expect(registry.allPlugins().has("off-one")).toBe(false);

    disabledList = [];
    const r2 = await reload();
    expect(r2.activated).toEqual(["off-one"]);
  });

  it("④' 运行中被禁用 → 下一次重扫摘掉它", async () => {
    writePlugin("user", "insight", "off-one");
    await reload();
    expect(registry.allPlugins().has("off-one")).toBe(true);
    disabledList = ["off-one"];
    const r = await reload();
    expect(r.deactivated).toEqual(["off-one"]);
    expect(registry.allPlugins().has("off-one")).toBe(false);
  });

  it("⑤ 两边都有 → 原样保留，**不重跑 activate**（languages 槽没有去重，重复注册会翻倍）", async () => {
    writePlugin("builtin", "themes", "steady");
    await reload();
    const langsBefore = registry.languageContributions().length;
    const notifiedBefore = notified;

    const r = await reload();
    expect(r.unchanged).toEqual(["steady"]);
    expect(r.activated).toEqual([]);
    expect(r.deactivated).toEqual([]);
    expect(r.changed, "什么都没变就不该报告 changed（也不该多广播）").toBe(false);
    expect(notified, "unchanged 不该触发任何广播").toBe(notifiedBefore);
    expect(registry.languageContributions().length, "语言贡献不能翻倍").toBe(langsBefore);
  });

  it("优先级：高优先级根覆盖低优先级（与冷启动的注册序一致）", async () => {
    writePlugin("builtin", "themes", "dup", { displayName: "内置版" } as never);
    writePlugin("project", "themes", "dup", { displayName: "项目版" } as never);
    await reload();
    expect(registry.allPlugins().get("dup")?.source, "project 根优先级最高").toBe("project");
    expect(registry.manifestOf("dup")?.displayName).toBe("项目版");
  });

  it("单个插件激活失败进 errors 而**不阻断**其余（暖路径不把在跑的应用打回不可用）", async () => {
    writePlugin("user", "sessions", "ok-one");
    writePlugin("user", "sessions", "bad-one");
    // 让 loader 只对 bad-one 抛错：activate 内部会 catch → 撤注册 → 返回 { ok:false }，
    // 于是它进 errors，而 ok-one 照常激活。这正是"用户投递了一个坏插件"时该有的行为。
    (deps.loader as unknown as { load: (m: { id: string }, p: string) => Promise<void> }).load = async (m) => {
      if (m.id === "bad-one") throw new Error("加载 bad-one 失败（注入）");
    };
    const r = await reload();
    expect(r.activated, "坏插件不该阻断好的").toEqual(["ok-one"]);
    expect(r.errors.map((e) => e.id)).toEqual(["bad-one"]);
    expect(registry.allPlugins().has("ok-one")).toBe(true);
    expect(registry.allPlugins().has("bad-one"), "失败的插件要撤注册（否则贡献项残留成孤儿 Tab）").toBe(false);
  });

  it("重扫**开头**就失败（读偏好炸了）→ 错误必须冒泡，且不留下半装状态", async () => {
    // 与上一条分工：那条是"某个插件坏了"，这条是"重扫本身没法进行"。
    // 后者静默吞掉会更糟——调用方会以为收敛成功了，而注册表其实一动不动。
    writePlugin("user", "sessions", "ok-one");
    (deps.configStore as unknown as { get: (a: string, b: string) => Promise<unknown> }).get = async () => {
      throw new Error("读偏好失败（注入）");
    };
    await expect(reload()).rejects.toThrow(/读偏好失败/);
    expect(registry.allPlugins().has("ok-one"), "失败时不该留下半装状态").toBe(false);
  });
});
