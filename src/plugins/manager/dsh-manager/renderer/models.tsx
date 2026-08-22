// dsh-manager 插件 renderer ——「DSH 入口 · DSH 模型」TAB（薄 wrapper）。
//
// 模型配置走共享 base ModelConfigPage（kernel-design-spec.md §12.5）。dsh 的能力旗标：
// reasoning=false（dsh 是 agent 级 reasoningEffort，非 per-model 布尔 → 显式降级，隐藏该列）。
// 数据/保存走框架（config/onChange/dirty 由 SettingsPage 注入），本 wrapper 只填 spec。
import { ModelConfigPage, usePluginContext, type SettingsComponentProps } from "@my-harness-desktop/react";

export const channels = ["dsh-manager:defaultChanged"] as const;

export function DshModelsPage(props: SettingsComponentProps): React.ReactNode {
  const ctx = usePluginContext();
  return (
    <ModelConfigPage
      api={ctx.kernelModels.dsh}
      i18nPrefix="dshModels"
      capabilities={{ reasoning: false }}
      config={props.config}
      dirty={props.dirty ?? false}
      onChange={props.onChange}
      onDefaultChanged={(sel) => ctx.events.emit(channels[0], { provider: sel.provider, modelId: sel.model })}
    />
  );
}
