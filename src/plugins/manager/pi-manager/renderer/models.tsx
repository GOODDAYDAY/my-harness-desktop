// pi-manager 插件 renderer ——「PI 入口 · 模型配置」TAB（薄 wrapper）。
//
// 模型配置走共享 base ModelConfigPage（kernel-design-spec.md §12.5）：pi/dsh 只填 spec，
// 增删改/测试/默认模型/导入/保存全在 base。pi 的能力旗标：reasoning=true（per-model 布尔）。
// channels 必须 re-export：框架从入口 module 读 module.channels 注册事件总线。
import { ModelConfigPage, type SettingsComponentProps, usePluginContext } from "@my-harness-desktop/react";

export const channels = ["pi-manager:defaultChanged"] as const;

export function ModelManagerPage(_props: SettingsComponentProps): React.ReactNode {
  const ctx = usePluginContext();
  return (
    <ModelConfigPage
      api={ctx.kernelModels.pi}
      i18nPrefix="models"
      capabilities={{ reasoning: true }}
      onDefaultChanged={(sel) => ctx.events.emit(channels[0], { provider: sel.provider, modelId: sel.model })}
    />
  );
}
