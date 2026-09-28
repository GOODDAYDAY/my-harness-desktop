// controller 侧的**活访问器**守卫（boot-surface.md §3.6.3）。
//
// 守的不是"能取到值"，而是这次改造的**全部理由**：
//   ① `registerKernel` 跑完之后再往注册表加内核，`kernel.list` / `kernelModels` 等必须**立刻**
//      看到它——快照形状（今天的 `Record<KernelId,X>` + 解构出的局部常量）做不到，
//      这正是"内核插件重载后 controller 仍在用旧清单"的根因；
//   ② 缺面必须抛**可行动**错误（点名内核与面名 + 下一步），不能退化成
//      `TypeError: Cannot read properties of undefined`。函数形状把 total 的 Record
//      换成了 `T | undefined`，不管它就会退化——这条义务必须有测试盯着；
//   ③ 遍历语义下缺面**跳过**而不是抛（`models.getFallbackModel` / `llm.oneshot`）。
//
// 夹具用**真的** `KernelRegistry` + **真的** `liveKernelAccessors`（不是 mock）：
// 要验的就是"controller 经访问器读到的是注册表的当前状态"，用替身会把这条验成空话。

import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { initTranslator } from "../application/i18n/translator";

// ⚠ 被测代码的错误消息在 r78 起走**服务端 i18n 查表**（`t("shell.kernelFaceMissing", …)`），
//   而 translator 的单例需要显式 init，否则 `t()` 退化成返回键名——那样下面的断言
//   （点名内核/点名面/给出下一步）就全都变成在断言一个键字符串，失去意义。
//   所以这里用**真实语言包**初始化（与 r56 给 ws-transport 测试真字典同一套做法）：
//   断言继续检查真文案，**不软化断言、不改写成断言键名**。
const HERE = dirname(fileURLToPath(import.meta.url));
// 语言包文件里是**带 ns 前缀的扁平键**（`"shell.kernelFaceMissing": "…"`），
// 而 merge 的规则是「第一个 dot 前是 namespace、其余按 dot 分层嵌套」（merge.ts 注释与实现），
// i18next 要的形状是 `{ "zh-CN": { shell: { kernelFaceMissing: "…" } } }`。
// 所以这里按同一规则转换——**不能把扁平对象直接当 resources 传**，
// 否则查 `shell.kernelFaceMissing` 会在 ns=shell 里找 key=kernelFaceMissing 而落空，
// t() 返回键尾（首版就是这么错的：断言收到 "kernelFaceMissing" 而不是译文）。
const SHELL_FLAT = JSON.parse(
  readFileSync(join(HERE, "../../plugins/system/i18n/locales/zh-CN/shell.json"), "utf-8"),
) as Record<string, string>;
const SHELL_ZH: Record<string, string> = {};
for (const [k, v] of Object.entries(SHELL_FLAT)) {
  const dot = k.indexOf(".");
  SHELL_ZH[dot > 0 ? k.slice(dot + 1) : k] = v;
}
import { registerKernel } from "./kernel";
import { KernelRegistry } from "../kernel/core/kernel-registry";
import { liveKernelAccessors } from "../bootstrap/boot/kernel-accessors";
import { IPC } from "@my-harness-desktop/shared";
import type {
  BaseBackend,
  KernelConfigApi,
  KernelExtensionSource,
  KernelId,
  KernelLogo,
  KernelModelSource,
  KernelModelsApi,
  KernelPlugin,
  SessionCatalog,
  KernelVersionApi,
} from "@my-harness-desktop/shared";

const kid = (s: string): KernelId => s as KernelId;
const LOGO: KernelLogo = { viewBox: "0 0 24 24", label: "x", paths: [{ d: "M0 0" }] };

function makePlugin(id: string, over: Partial<KernelPlugin> = {}): KernelPlugin {
  return {
    id: kid(id),
    logo: LOGO,
    createBackend: () => ({}) as BaseBackend,
    createCatalog: () => ({}) as SessionCatalog,
    createModelSource: () => ({}) as KernelModelSource,
    createModelsApi: () => ({ list: async () => [], getDefault: async () => null }) as unknown as KernelModelsApi,
    createConfigApi: () => ({}) as KernelConfigApi,
    createExtensionSource: () => ({}) as KernelExtensionSource,
    createVersionApi: () => ({}) as KernelVersionApi,
    ...over,
  };
}

const handlers = new Map<string, (...a: unknown[]) => unknown>();
const gateway = { register: (ch: string, h: (...a: unknown[]) => unknown) => { handlers.set(ch, h); }, broadcast: () => {} };

let registry: KernelRegistry;

function install(): void {
  registry = new KernelRegistry();
  const accessors = liveKernelAccessors(registry);
  const ctx = {
    // 八个函数形状的派生面：直接来自活访问器（与 50-wiring 的装配方式同构）
    kernelIds: accessors.kernelIds,
    kernelConfigRoots: accessors.kernelConfigRoots,
    kernelModels: accessors.kernelModels,
    kernelConfig: accessors.kernelConfig,
    kernelVersionApi: accessors.kernelVersionApi,
    kernelExtensionSource: accessors.kernelExtensionSource,
    kernelLogo: accessors.kernelLogo,
    kernelOneshot: accessors.kernelOneshot,
    // 其余面用最小替身（本测试不走它们）
    registry: { assertPermission: () => {} },
    sessionStore: { getActiveCwd: () => null },
    modelCatalog: { listModels: async () => [] },
  };
  registerKernel(gateway as never, ctx as never);
}

const call = (ch: string, ...args: unknown[]): unknown => handlers.get(ch)!!({} as never, ...args);

beforeEach(() => { handlers.clear(); install(); });

describe("registerKernel：注册表派生面是活的（不是构造期快照）", () => {
  beforeAll(async () => {
    await initTranslator({
      resources: { "zh-CN": { shell: SHELL_ZH } },
      lng: "zh-CN",
      ns: ["shell"],
      supportedLngs: ["zh-CN"],
    });
  });

  it("① controller 注册**之后**才加的内核，立刻出现在 kernel.list 里", () => {
    // 这条是本次改造的判据本身：快照形状下 kernel.list 永远返回注册那一刻的清单，
    // 内核插件重载后 controller 仍在报旧内核（而 handler 早已注册完，没有机会重建）。
    expect(call(IPC.kernel.list)).toEqual([]);
    registry.register(makePlugin("alpha"), "1.0.0");
    expect(call(IPC.kernel.list)).toEqual([{ id: kid("alpha"), logo: LOGO }]);
    registry.register(makePlugin("beta"), "1.0.0");
    expect((call(IPC.kernel.list) as { id: string }[]).map((x) => x.id)).toEqual(["alpha", "beta"]);
    registry.unregister(kid("alpha"));
    expect((call(IPC.kernel.list) as { id: string }[]).map((x) => x.id), "卸载后清单也要跟着变").toEqual(["beta"]);
  });

  it("① models.getFallbackModel 遍历的是**当前**注册表（后加的内核也能被选中）", async () => {
    expect(await call(IPC.models.getFallbackModel)).toBeNull();
    registry.register(
      makePlugin("alpha", {
        createModelsApi: () => ({
          list: async () => [{ id: "p1", models: [{ id: "m1" }] }],
          getDefault: async () => ({ provider: "p1", model: "m1" }),
        }) as unknown as KernelModelsApi,
      }),
      "1.0.0",
    );
    expect(await call(IPC.models.getFallbackModel)).toEqual({ provider: "p1", model: "m1", kernel: kid("alpha") });
  });

  it("② 缺面抛**可行动**错误：点名内核 id 与面名，并给出下一步", () => {
    // 用 ghost（从未注册）调模型面：必须抛我们自己的错误，不是 TypeError。
    let err: unknown;
    try { call(IPC.kernelModels.list, kid("ghost")); } catch (e) { err = e; }
    expect(err, "缺面必须抛错，不能静默返回 undefined").toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(TypeError);            // ★ 不是 undefined.list() 那种崩法
    const msg = (err as Error).message;
    expect(msg).toContain("ghost");                        // 点名内核
    expect(msg).toContain("模型配置");                      // 点名面
    expect(msg, "要给出下一步动作，否则用户不知道能怎么办").toMatch(/重载|装载|卸载/);
  });

  it("② 版本面与原生配置面同样抛可行动错误（不是每个面各写一套）", () => {
    for (const [ch, face] of [[IPC.kernelVersion.status, "版本管理"], [IPC.kernelConfig.get, "原生配置"]] as const) {
      let msg = "";
      try { call(ch, kid("ghost")); } catch (e) { msg = (e as Error).message; }
      expect(msg, `${ch} 的错误消息应点名面「${face}」`).toContain(face);
      expect(msg).toContain("ghost");
    }
  });

  it("③ 遍历语义下缺面**跳过**而不是抛：oneshot 遍历完才报「无内核提供该能力」", () => {
    // 注册一个没有 oneshot 面的内核：遍历应当跳过它，最后抛"无内核提供"——
    // 而不是在第一个内核上就抛"没有 oneshot 面"（那会让多内核共存时永远走不到有能力的那个）。
    registry.register(makePlugin("alpha"), "1.0.0");
    let msg = "";
    try { call(IPC.llm.oneshot, "some-plugin", "hi"); } catch (e) { msg = (e as Error).message; }
    // ⚠ r79 起这条消息走服务端 i18n（shell.noOneshotCapability），所以断言**从真字典取文案**，
    //   不再复制中文字面量（复制一份就等于把文案在测试里存了第二遍，将来必然漂移）。
    //   SHELL_ZH 是 ns 剥离后的映射（见文件头），所以键名不带 "shell." 前缀。
    const aggregate = SHELL_ZH["noOneshotCapability"];
    const perId = SHELL_ZH["kernelFaceMissing"];
    expect(aggregate, "字典里必须有聚合错误的译文（否则下面的断言是空转）").toBeTruthy();
    expect(perId, "字典里必须有 per-id 缺面错误的译文").toBeTruthy();
    // 聚合错误没有插值变量，所以可以整句相等——这同时证明它**不是** per-id 那条
    // （per-id 那条含 {{kernel}}/{{face}}，渲染出来必然带上具体内核名）。
    expect(msg, "遍历完应报聚合错误（而不是 per-id 的缺面错误）").toBe(aggregate);
    expect(msg, "不该是 per-id 的缺面错误").not.toBe(perId.replace("{{kernel}}", "").replace("{{face}}", ""));
  });

  it("③ 有 oneshot 面的内核被选中（跳过没面的，命中有面的）", async () => {
    registry.register(makePlugin("no-face"), "1.0.0");
    registry.register(makePlugin("with-face", { createOneshot: () => async () => "答复" }), "1.0.0");
    expect(await call(IPC.llm.oneshot, "some-plugin", "问")).toBe("答复");
  });

  it("logo 面：从未在册 → undefined（合法状态，不抛错，让 renderer 回落占位）", () => {
    // 与 per-id 的模型/配置面**处置不同**：抛错会让 renderer 的占位回落路径走不到。
    expect(call(IPC.kernelLogos.get, kid("ghost"))).toBeUndefined();
    registry.register(makePlugin("alpha"), "1.0.0");
    expect(call(IPC.kernelLogos.get, kid("alpha"))).toBe(LOGO);
    registry.unregister(kid("alpha"));
    expect(call(IPC.kernelLogos.get, kid("alpha")), "卸载后仍返回 last-known logo").toBe(LOGO);
  });
});
