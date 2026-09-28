// IPC:内核管理 + 内核 settings/models 配置(kernel.*/dshKernel.*/piSettings.*/models.*/kernelModels.*)。
import type { Gateway } from "../routing/gateway";
import type { KernelStatus } from "../kernel/core/kernel-manager";
import { IPC } from "@my-harness-desktop/shared";
import { t } from "../application/i18n/translator";
import type { MainContext } from "../application/context/main-context";
import { broadcastRefreshRequested } from "../routing/broadcast";
// ⚠ 此前这行还 import 了 `DshProvider`——**死 import**（全文零使用）。它让壳看起来认识 dsh 的
// provider 形状；实际壳只经中性 `KernelConfigApi` 驱动内核配置（dsh 的 provider CRUD 由 dsh
// 自己的内核插件 src/plugins/kernels/dsh/renderer/models.tsx 消费）。
import type { KernelModelsApi, KernelConfigApi } from "@my-harness-desktop/shared";
import type { KernelId } from "@my-harness-desktop/shared";
import type { ModelProbeInput } from "@my-harness-desktop/shared";
import { discoverModels, pingModel } from "../client/provider-probe";

export function registerKernel(gateway: Gateway, ctx: MainContext): void {
  // ⚠ 这里**不再解构**注册表派生面（§3.6.3）。此前解构出的六个局部常量是构造期快照，
  //   内核插件重载后不会更新——而这个文件里两种模式并存（一半用解构量、一半直接读 ctx.X），
  //   所以只改一半的 handler 会 stale。函数形状下 `ctx.kernelIds()` 这类调用每次现读注册表。

  /** 取某内核的面；缺面抛**可行动**错误（点名内核与面名 + 下一步）。
   *  函数形状带来的新义务：访问器返回 `T | undefined`，不管它就退化成
   *  `TypeError: Cannot read properties of undefined`——那不是可行动错误。 */
  const need = <T>(v: T | undefined, kernel: KernelId, face: string): T => {
    if (v === undefined) {
      // 面向用户的错误（含操作指引"在设置页重载内核插件后重试"）⇒ 走服务端 i18n 查表，
      // 不写死中文（r78：英文界面里冒出中文句子是 i18n 泄漏）。键在 system/i18n 的 shell.json。
      throw new Error(t("shell.kernelFaceMissing", { kernel, face }));
    }
    return v;
  };

  // ---- IPC:内核清单(运行时注册表动态提供;替代 KERNEL_IDS 字面量数组)。 ----
  gateway.register(IPC.kernel.list, () => ctx.kernelIds().map((id) => ({ id, logo: ctx.kernelLogo(id) })));
  // 内核插件差量重载：返回变化清单（added/replaced/removed/unchanged/errors），
  // 由调用方决定怎么呈现——controller 不猜 UI 语义（§1.2 机制与内容分离）。
  gateway.register(IPC.kernel.reload, () => ctx.reloadKernelPlugins());

  // ---- IPC:内核版本管理(中性,带 kernel 参数)——版本管理逻辑已收进插件工厂的 wrapVersionApi,
  // 这里只委托给 ctx.kernelVersionApi(kernel)。install 的进度/完成事件按 kernel 过滤广播。
  const versionApi = (kernel: KernelId) => need(ctx.kernelVersionApi(kernel), kernel, "版本管理");
  gateway.register(IPC.kernelVersion.capabilities, (_e, kernel: KernelId) => versionApi(kernel).capabilities());
  gateway.register(IPC.kernelVersion.status, (_e, kernel: KernelId) => versionApi(kernel).status());
  gateway.register(IPC.kernelVersion.setCustomCliDir, (_e, kernel: KernelId, dir: string) => versionApi(kernel).setCustomCliDir(dir));
  gateway.register(IPC.kernelVersion.listVersions, (_e, kernel: KernelId, forceRefresh: boolean) => versionApi(kernel).listVersions(forceRefresh));
  gateway.register(IPC.kernelVersion.install, (_e, kernel: KernelId, version: string) => versionApi(kernel).install(version,
    (line: string) => gateway.broadcast(IPC.kernelVersion.installProgress, kernel, line),
    (result) => gateway.broadcast(IPC.kernelVersion.installDone, kernel, result),
  ));
  // tool-gate 内核扩展可用性探测(能力探测,带 kernel 参数;pi 有、dsh/minimal 无此面 → false)。
  gateway.register(IPC.kernelVersion.toolFilterEnforced, (_e, kernel: KernelId) => versionApi(kernel).toolFilterEnforced?.() ?? false);

  // dsh 模型配置经中性面 kernelModels["dsh"](createDshModelsApi 实现),不再走专属 dshModels IPC。
  // ---- IPC:中性内核管理 API(kernel-design-spec.md §12.5)——模型页----
  const modelsApi = (kernel: KernelId): KernelModelsApi => need(ctx.kernelModels(kernel), kernel, "模型配置");

  gateway.register(IPC.kernelModels.list, (_e, kernel: KernelId) => modelsApi(kernel).list());
  gateway.register(IPC.kernelModels.set, (_e, kernel: KernelId, provider: string, detail) => modelsApi(kernel).set(provider, detail));
  gateway.register(IPC.kernelModels.remove, (_e, kernel: KernelId, provider: string) => modelsApi(kernel).remove(provider));
  gateway.register(IPC.kernelModels.rename, (_e, kernel: KernelId, oldId: string, newId: string) => modelsApi(kernel).rename(oldId, newId));
  gateway.register(IPC.kernelModels.getDefault, (_e, kernel: KernelId) => modelsApi(kernel).getDefault());
  // 设默认模型后广播**中性刷新信号**（不是内核专属频道）。
  // 此前 renderer 侧"默认模型变了"靠插件私有频道传递（`<内核名>-manager:defaultChanged`），
  // 于是 timeline 插件里硬编码了**另一个插件的 id** —— 违反 §8.3 零硬编码，
  // 且每加一个内核就要多一个频道、多一处订阅。改用与 kernel:install / setCustomCliDir
  // 同族的 `refresh.requested`（语义就是"内核外部状态变了，重探"）：第四个内核自动被覆盖，
  // timeline 只需订阅这一个中性信号（订阅点见 timeline/renderer/index.tsx）。
  gateway.register(IPC.kernelModels.setDefault, async (_e, kernel: KernelId, sel) => {
    const r = await modelsApi(kernel).setDefault(sel);
    broadcastRefreshRequested(gateway);
    return r;
  });
  gateway.register(IPC.kernelModels.test, (_e, kernel: KernelId, cwd: string, provider: string, modelId: string) => modelsApi(kernel).test(cwd, provider, modelId));
  gateway.register(IPC.kernelModels.readConfig, (_e, kernel: KernelId) => modelsApi(kernel).readConfig());
  gateway.register(IPC.kernelModels.saveConfig, (_e, kernel: KernelId, config) => modelsApi(kernel).saveConfig(config));
  // ---- IPC:模型探测(model-probe:发现 + ping;纯 HTTP,内核无关,连接事实由调用方显式传)----
  gateway.register(IPC.modelProbe.discover, (_e, input: ModelProbeInput) => discoverModels(input));
  gateway.register(IPC.modelProbe.ping, (_e, input: ModelProbeInput & { model: string }) => pingModel(input));
  // ---- IPC:中性内核原生配置 API(kernel 配置 TAB 用)----
  const configApi = (kernel: KernelId): KernelConfigApi => need(ctx.kernelConfig(kernel), kernel, "原生配置");
  gateway.register(IPC.kernelConfig.get, (_e, kernel: KernelId) => configApi(kernel).get());
  gateway.register(IPC.kernelConfig.set, (_e, kernel: KernelId, obj: Record<string, unknown>) => configApi(kernel).set(obj));
  gateway.register(IPC.kernelConfig.fields, (_e, kernel: KernelId) => configApi(kernel).fields());
  // ---- IPC:内核身份标(logo)取回——每个内核在自己适配器声明,壳经此渲染(不硬编码)----
  // logo 不套 need()：缺面是**合法状态**（从未在册的 id → undefined，renderer 回落占位；
  // 已卸载但曾在册 → last-known logo，见 kernel-accessors.ts 的 logoOf）。抛错反而会让
  // renderer 的占位回落路径走不到。
  gateway.register(IPC.kernelLogos.get, (_e, kernel: KernelId) => ctx.kernelLogo(kernel));
  // ---- IPC:pi 内核 settings(pi-settings 插件,读写 ~/.pi/agent/settings.json)----
  // pi settings 配置经中性面 kernelConfig["pi"](get/set/fields),不再走专属 piSettings IPC。


  // pi models.json 整份读写经 kernelModels["pi"].readConfig/saveConfig,不再走专属 models.get/set。
  // ---- IPC:合流模型清单(pi + dsh,带 kernel 标;会话流模型下拉用,设计 §3.3)----
  gateway.register(IPC.models.list, () => ctx.modelCatalog.listModels());
  // ---- IPC:中性「兜底模型」(新会话无显式选择时壳 renderer 用;不再直读 pi models.json)----
  // 语义:返回「需要显式 set 的兜底模型」(含 kernel——内核由模型归属决定,不靠 provider 名猜)。
  // 遍历注册内核(注册表顺序),找第一个有默认模型的内核;无默认模型则首个有模型的内核。
  gateway.register(IPC.models.getFallbackModel, async () => {
    // 这两轮遍历是"找第一个有能力面的内核"，所以缺面**跳过**而不是抛错
    // （与下面 llm:oneshot 同款处置：遍历语义下 undefined 是正常情况）。
    for (const kernel of ctx.kernelIds()) {
      const api = ctx.kernelModels(kernel);
      if (!api) continue;
      const def = await api.getDefault();
      if (def) return { provider: def.provider, model: def.model, kernel };
    }
    for (const kernel of ctx.kernelIds()) {
      const api = ctx.kernelModels(kernel);
      if (!api) continue;
      const providers = await api.list();
      const first = providers.find((p) => p.models.length > 0);
      if (first) return { provider: first.id, model: first.models[0].id, kernel };
    }
    return null;
  });

  // ---- IPC:llm:oneshot 声明能力(一次性问内核;遍历注册内核找第一个提供 oneshot 的,缺面显式报错)----
  gateway.register(IPC.llm.oneshot, (_e, pluginId: string, prompt: string) => {
    ctx.registry.assertPermission(pluginId, "llm:oneshot");
    for (const kernel of ctx.kernelIds()) {
      const oneshot = ctx.kernelOneshot(kernel);
      if (oneshot) return oneshot(prompt, ctx.sessionStore.getActiveCwd() ?? undefined);
    }
    // 面向用户：这条会经插件的 catch 被**插进用户可见文案**
    // （git-review 的 setActionError(t("review.generateFailed", { error: err.message }))），
    // 于是英文界面里会出现 "Generation failed: 无内核提供 llm:oneshot 能力" —— i18n 泄漏。
    // r79 改走服务端 i18n 查表（机制见 r78 接线的 initTranslator）。
    throw new Error(t("shell.noOneshotCapability"));
  });
}
