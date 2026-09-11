// pi 内核插件 renderer ——「PI 入口 · 模型配置」TAB（薄 wrapper）。
//
// 模型配置走共享 base ModelConfigPage（kernel-design-spec.md §12.5）：pi/dsh 只填 spec，
// 增删改/测试/默认模型/导入/保存全在 base。pi 的能力旗标：reasoning=true（per-model 布尔）。
// 数据/保存走框架（config/onChange/dirty 由 SettingsPage 注入），本 wrapper 只填 spec。
// **不再声明私有频道**：此前这里 emit `<内核名>-manager:defaultChanged`，让 timeline 订阅——
// 那是"插件认插件 id"（§8.3 禁止），且每个内核各要一个频道。现在"默认模型变了"由 main 侧
// 在 kernelModels.setDefault 后广播中性信号 system:refreshRequested（controllers/kernel.ts），
// 消费方只认这一个信号，加第四个内核零改动。onDefaultChanged 仍保留为本地回调位（base 需要它
// 立即回显），但不再往事件总线抛内核专属频道。
import { ModelConfigPage, usePluginContext, type SettingsComponentProps } from "@my-harness-desktop/react";

export function ModelManagerPage(props: SettingsComponentProps): React.ReactNode {
  const ctx = usePluginContext();
  return (
    <ModelConfigPage
      api={ctx.kernelModels.pi}
      i18nPrefix="models"
      capabilities={{ reasoning: true }}
      config={props.config}
      dirty={props.dirty ?? false}
      onChange={props.onChange}
    />
  );
}
