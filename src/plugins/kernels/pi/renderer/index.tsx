// pi 内核插件 · desktop 对接面 renderer ——「PI 入口」的 TAB 组件入口。
//
// 三个 TAB 的组件都在本插件(合并 pi-kernel-manager + pi-settings + extension-manager + pi-model-manager):
//   PiManagerPage     —— TAB 1「Pi」(内核版本 + 配置),本文件内联
//   ExtensionManagerPage —— TAB 2「PI 拓展」,./extensions.tsx
//   ModelManagerPage  —— TAB 3「模型配置」,./models.tsx
// 经 manifest 的 contributes.settings[].tabs 声明,框架按 component 名自动匹配本入口的 exports。
//
// 配置表单走共享 base KernelConfigForm(schema 驱动):pi 的字段 schema 由适配器
// (client/pi/pi-kernel-config.ts)翻译,本插件不再硬编码 FIELD_DESCRIPTORS——字段知识
// 从壳插件下沉到内核适配器,壳只认中性 KernelConfigField。
import type { SettingsComponentProps } from "@my-harness-desktop/react";
import { KernelConfigForm, KernelVersionPage, usePluginContext } from "@my-harness-desktop/react";

// TAB 2 / TAB 3 的组件从各自文件迁入,在此 re-export 供框架按 component 名匹配(§7.4)。
// **本插件不再声明任何私有频道**:「默认模型变了」由 main 侧广播中性信号
// system:refreshRequested(controllers/kernel.ts),消费方订阅框架信号即可——
// 插件之间不认彼此的 id/channel(§8.3),加第四个内核零频道改动。
export { ExtensionManagerPage } from "./extensions";
export { ModelManagerPage } from "./models";

// ============ PiManagerPage ============
// TAB 1「Pi」:内核版本管理走共享 base(kernel-design-spec.md §12.4),配置表单走共享 base
// KernelConfigForm(schema 驱动)。数据/保存走框架(config/onChange 由 SettingsPage 注入,
// manifest kernelConfig="pi" 声明走 kernelConfig.pi 的 get/set)。
export function PiManagerPage({ refreshSignal, config, onChange }: SettingsComponentProps): React.ReactNode {
  const ctx = usePluginContext();
  return (
    <>
      <KernelVersionPage api={ctx.kernels.pi} i18nPrefix="kernel" />
      <div style={{ borderTop: "2px solid var(--color-border)" }} />
      <KernelConfigForm api={ctx.kernelConfig.pi} config={config} onChange={onChange} refreshSignal={refreshSignal} />
    </>
  );
}
