// IPC:内核管理 + 内核 settings/models 配置(kernel.*/dshKernel.*/piSettings.*/models.*/kernelModels.*)。
import type { Gateway } from "../routing/gateway";
import type { KernelStatus } from "../kernel/core/kernel-manager";
import { IPC } from "@my-harness-desktop/shared";
import type { MainContext } from "../application/context/main-context";
import { broadcastRefreshRequested } from "../routing/broadcast";
import type { DshProvider, KernelModelsApi, KernelConfigApi } from "@my-harness-desktop/shared";
import type { KernelId } from "@my-harness-desktop/shared";
import type { ModelProbeInput } from "@my-harness-desktop/shared";
import { discoverModels, pingModel } from "../client/provider-probe";

export function registerKernel(gateway: Gateway, ctx: MainContext): void {
  const { kernelVersionApis, kernelIds, kernelOneshots, kernelLogos, kernelModels, kernelConfig } = ctx;

  // ---- IPC:内核清单(运行时注册表动态提供;替代 KERNEL_IDS 字面量数组)。 ----
  gateway.register(IPC.kernel.list, () => kernelIds.map((id) => ({ id, logo: kernelLogos[id] })));

  // ---- IPC:内核版本管理(中性,带 kernel 参数)——版本管理逻辑已收进插件工厂的 wrapVersionApi,
  // 这里只委托给 kernelVersionApis[kernel]。install 的进度/完成事件按 kernel 过滤广播。
  gateway.register(IPC.kernelVersion.capabilities, (_e, kernel: KernelId) => kernelVersionApis[kernel].capabilities());
  gateway.register(IPC.kernelVersion.status, (_e, kernel: KernelId) => kernelVersionApis[kernel].status());
  gateway.register(IPC.kernelVersion.setCustomCliDir, (_e, kernel: KernelId, dir: string) => kernelVersionApis[kernel].setCustomCliDir(dir));
  gateway.register(IPC.kernelVersion.listVersions, (_e, kernel: KernelId, forceRefresh: boolean) => kernelVersionApis[kernel].listVersions(forceRefresh));
  gateway.register(IPC.kernelVersion.install, (_e, kernel: KernelId, version: string) => kernelVersionApis[kernel].install(version,
    (line: string) => gateway.broadcast(IPC.kernelVersion.installProgress, kernel, line),
    (result) => gateway.broadcast(IPC.kernelVersion.installDone, kernel, result),
  ));
  // tool-gate 内核扩展可用性探测(能力探测,带 kernel 参数;pi 有、dsh/minimal 无此面 → false)。
  gateway.register(IPC.kernelVersion.fitPiExtensionAvailable, (_e, kernel: KernelId) => kernelVersionApis[kernel].fitPiExtensionAvailable?.() ?? false);

  // dsh 模型配置经中性面 kernelModels["dsh"](createDshModelsApi 实现),不再走专属 dshModels IPC。
  // ---- IPC:中性内核管理 API(kernel-design-spec.md §12.5)——模型页----
  const modelsApi = (kernel: KernelId): KernelModelsApi => kernelModels[kernel];

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
  const configApi = (kernel: KernelId): KernelConfigApi => kernelConfig[kernel];
  gateway.register(IPC.kernelConfig.get, (_e, kernel: KernelId) => configApi(kernel).get());
  gateway.register(IPC.kernelConfig.set, (_e, kernel: KernelId, obj: Record<string, unknown>) => configApi(kernel).set(obj));
  gateway.register(IPC.kernelConfig.fields, (_e, kernel: KernelId) => configApi(kernel).fields());
  // ---- IPC:内核身份标(logo)取回——每个内核在自己适配器声明,壳经此渲染(不硬编码)----
  gateway.register(IPC.kernelLogos.get, (_e, kernel: KernelId) => ctx.kernelLogos[kernel]);
  // ---- IPC:pi 内核 settings(pi-settings 插件,读写 ~/.pi/agent/settings.json)----
  // pi settings 配置经中性面 kernelConfig["pi"](get/set/fields),不再走专属 piSettings IPC。


  // pi models.json 整份读写经 kernelModels["pi"].readConfig/saveConfig,不再走专属 models.get/set。
  // ---- IPC:合流模型清单(pi + dsh,带 kernel 标;会话流模型下拉用,设计 §3.3)----
  gateway.register(IPC.models.list, () => ctx.modelCatalog.listModels());
  // ---- IPC:中性「兜底模型」(新会话无显式选择时壳 renderer 用;不再直读 pi models.json)----
  // 语义:返回「需要显式 set 的兜底模型」(含 kernel——内核由模型归属决定,不靠 provider 名猜)。
  // 遍历注册内核(注册表顺序),找第一个有默认模型的内核;无默认模型则首个有模型的内核。
  gateway.register(IPC.models.getFallbackModel, async () => {
    for (const kernel of ctx.kernelIds) {
      const api = ctx.kernelModels[kernel];
      const def = await api.getDefault();
      if (def) return { provider: def.provider, model: def.model, kernel };
    }
    for (const kernel of ctx.kernelIds) {
      const api = ctx.kernelModels[kernel];
      const providers = await api.list();
      const first = providers.find((p) => p.models.length > 0);
      if (first) return { provider: first.id, model: first.models[0].id, kernel };
    }
    return null;
  });

  // ---- IPC:llm:oneshot 声明能力(一次性问内核;遍历注册内核找第一个提供 oneshot 的,缺面显式报错)----
  gateway.register(IPC.llm.oneshot, (_e, pluginId: string, prompt: string) => {
    ctx.registry.assertPermission(pluginId, "llm:oneshot");
    for (const kernel of kernelIds) {
      const oneshot = kernelOneshots[kernel];
      if (oneshot) return oneshot(prompt, ctx.sessionStore.getActiveCwd() ?? undefined);
    }
    throw new Error("无内核提供 llm:oneshot 能力");
  });
}
