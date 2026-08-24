// pi-manager 插件 renderer ——「PI 入口」的 TAB 组件入口。
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
// channels 也要 re-export:框架从入口 module 读 module.channels 注册事件总线,
// 模型默认变更频道在 models.tsx 里声明,不 re-export 则「未被任何插件注册」。
export { ExtensionManagerPage } from "./extensions";
export { ModelManagerPage, channels } from "./models";

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
      <KernelConfigForm api={ctx.kernelConfig.pi} i18nPrefix="kernel" config={config} onChange={onChange} refreshSignal={refreshSignal} />
    </>
  );
}
