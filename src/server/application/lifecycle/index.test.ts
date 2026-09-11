// lifecycle 的两组守卫 —— **纯逻辑 unittest**(registry/deps 用最小替身)。
// 对应源码里两处**与需求直接对应**的契约:
//
//  ① **停用/卸载的依赖闸**(= "插件能卸载仍没问题"的代码形态):
//     canDeactivate = protected 挡住(blockedBy:["protected"]) + checkDependents 挡住并**点名**
//     checkDependents 的两处细节:跳过自己 ✓、**跳过 error 态的插件**(它自己都坏了,不算有效依赖者)✓
//  ② **加载失败必须"撤贡献"**,而不是只打日志:
//     根因注释:「此前 renderer 加载失败**只 console.error**:main 注册表昭告了贡献、renderer
//     却无组件可注册,**右栏出现"组件未注册"孤儿 Tab**」
//     → 现在必须 置 error 态 ✓ + **registry.unregister** ✓ + notifyPluginsChanged ✓ 三件齐做
//
// 红绿证明:把 unregister 去掉 → ② 必红(留下孤儿 Tab);把 protected 判断去掉 → ① 必红。
import { describe, it, expect, beforeEach } from "vitest";

import {
  canUninstall,
  checkDependents,
  canDeactivate,
  reportLoadFailure,
  setPluginError,
  clearPluginState,
} from "./index";

type P = { id: string; dependsOn?: string[]; protected?: boolean };
const mkRegistry = (plugins: P[]): unknown => ({
  manifestOf: (id: string) => {
    const p = plugins.find((x) => x.id === id);
    return p ? { dependsOn: p.dependsOn, protected: p.protected } : undefined;
  },
  allPlugins: () => plugins.map((p) => [p.id, { manifest: { dependsOn: p.dependsOn, protected: p.protected } }]),
});

const IDS = ["core", "protected-one", "dep-a", "dep-b", "free"];

beforeEach(() => { for (const id of IDS) clearPluginState(id); });

describe("lifecycle:停用/卸载的依赖闸", () => {
  it("① canUninstall:普通插件可卸;**protected 不可卸**", () => {
    const r = mkRegistry([{ id: "core" }, { id: "protected-one", protected: true }]);
    expect(canUninstall("core", r as never)).toBe(true);
    expect(canUninstall("protected-one", r as never), "protected 插件被允许卸载").toBe(false);
  });

  it("② checkDependents:列出依赖它的插件;**跳过自己**", () => {
    const r = mkRegistry([{ id: "core" }, { id: "dep-a", dependsOn: ["core"] }, { id: "free" }]);
    expect(checkDependents("core", r as never).sort()).toEqual(["dep-a"]);
    expect(checkDependents("dep-a", r as never), "把自己算成了自己的依赖者").toEqual([]);
  });

  it("★ ②b **error 态的依赖者不算**(它自己都坏了,不该再挡住别人)", () => {
    const r = mkRegistry([{ id: "core" }, { id: "dep-a", dependsOn: ["core"] }, { id: "dep-b", dependsOn: ["core"] }]);
    expect(checkDependents("core", r as never).sort()).toEqual(["dep-a", "dep-b"]);
    setPluginError("dep-a");                                   // 让 dep-a 进 error 态
    expect(checkDependents("core", r as never), "error 态的插件仍被算作有效依赖者").toEqual(["dep-b"]);
  });

  it("③ canDeactivate:protected → 挡,且 blockedBy 点名 'protected'", () => {
    const r = mkRegistry([{ id: "protected-one", protected: true }]);
    expect(canDeactivate("protected-one", r as never)).toEqual({ ok: false, blockedBy: ["protected"] });
  });

  it("④ canDeactivate:有依赖者 → 挡,**并点名是谁**", () => {
    const r = mkRegistry([{ id: "core" }, { id: "dep-a", dependsOn: ["core"] }, { id: "dep-b", dependsOn: ["core"] }]);
    const res = canDeactivate("core", r as never);
    expect(res.ok, "有依赖者却允许停用(卸载后别处会静静崩)").toBe(false);
    expect(res.blockedBy?.sort(), "挡住了但没说是谁挡的").toEqual(["dep-a", "dep-b"]);
  });

  it("⑤ canDeactivate:无依赖者 → 放行", () => {
    const r = mkRegistry([{ id: "free" }, { id: "core" }]);
    expect(canDeactivate("free", r as never)).toEqual({ ok: true });
  });
});

describe("lifecycle:加载失败必须撤贡献(否则留'组件未注册'孤儿 Tab)", () => {
  it("★ ⑥ reportLoadFailure:置 error 态 **且 撤注册** 且 通知刷新 —— 三件齐做", () => {
    const calls: string[] = [];
    const deps = {
      registry: { unregister: (id: string) => { calls.push(`unregister:${id}`); } },
      notifyPluginsChanged: () => { calls.push("notify"); },
    };
    reportLoadFailure(deps as never, "broken-plugin");
    expect(calls, "**只打了日志/置了态却没撤注册** —— 右栏会留下'组件未注册'孤儿 Tab").toContain("unregister:broken-plugin");
    expect(calls, "没有通知前端刷新(注册表变了却没人知道)").toContain("notify");
  });

  it("★ ⑥b 撤注册后,它也不再是别人的有效依赖者(error 态)", () => {
    const r = mkRegistry([{ id: "core" }, { id: "dep-a", dependsOn: ["core"] }]);
    expect(checkDependents("core", r as never)).toEqual(["dep-a"]);
    setPluginError("dep-a");
    expect(checkDependents("core", r as never), "已置 error 的插件仍算依赖者").toEqual([]);
  });
});
