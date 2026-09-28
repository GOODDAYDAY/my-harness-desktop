// probe4 内核插件 · desktop 对接面 renderer ——「Probe4 入口」的 TAB 组件入口。
//
// 与 pi / dsh 的对接面**同构**（同一个共享 base、同一种三 TAB 切分、同一套 i18n 约定）：
//   Probe4ManagerPage    —— TAB 1「Probe4」(内核版本 + 原生配置),本文件内联
//   Probe4ExtensionsPage —— TAB 2「Probe4 拓展」,./extensions.tsx
//   Probe4ModelsPage     —— TAB 3「Probe4 模型」,./models.tsx
// 经 manifest 的 contributes.settings[].tabs 声明,框架按 component 名自动匹配本入口的 exports。
//
// 为什么 probe4 也应该有这一面（此前它**没有**，是三者里唯一缺管理面的）:
// 「内核无特权差异」不只是加载机制上的——pi/dsh 各有一个设置页入口，probe4 没有，
// 就等于它在用户可见面里是二等公民；而它其实真的有可管的东西（模型配置、原生配置、拓展）。
// 缺的从来不是能力，是**没人给它做对接面**。现在补齐，且刻意与另两个同构：
// 同共享 base、同 TAB 切分、同 i18n 命名空间约定——第四个内核照抄这一份即可。
import type { SettingsComponentProps } from "@my-harness-desktop/react";
import { KernelConfigForm, KernelVersionPage, usePluginContext } from "@my-harness-desktop/react";

// TAB 2 / TAB 3 的组件从各自文件迁入,在此 re-export 供框架按 component 名匹配(§7.4)。
// 本插件不声明任何私有频道——「默认模型变了」走框架中性信号 system:refreshRequested。
export { Probe4ExtensionsPage } from "./extensions";
export { Probe4ModelsPage } from "./models";

// ============ Probe4ManagerPage ============
// TAB 1「Probe4」:内核版本管理走共享 base(kernel-design-spec.md §12.4),配置表单走共享 base
// KernelConfigForm(schema 驱动)。probe4 是内置内核:版本面由适配器交显式降级(不装不升不降,
// 文案说明"内置"),配置面当前无字段(空清单=不渲染),但存储是真的(写进去读得回来)。
export function Probe4ManagerPage({ refreshSignal, config, onChange }: SettingsComponentProps): React.ReactNode {
  const ctx = usePluginContext();
  return (
    <>
      <KernelVersionPage api={ctx.kernels.probe4} i18nPrefix="probe4" />
      <div style={{ borderTop: "2px solid var(--color-border)" }} />
      <KernelConfigForm api={ctx.kernelConfig.probe4} config={config} onChange={onChange} refreshSignal={refreshSignal} />
    </>
  );
}
