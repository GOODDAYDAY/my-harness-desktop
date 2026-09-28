// probe4 内核插件 renderer ——「Probe4 入口 · Probe4 模型」TAB（薄 wrapper）。
//
// 模型配置走共享 base ModelConfigPage（kernel-design-spec.md §12.5）。三个内核只填 spec，
// 增删改/测试/默认模型/导入/保存全在 base。
//
// probe4 的能力旗标 reasoning=false：probe4 的模型配置里没有 reasoning 档位映射
// （它是 OpenAI 兼容的直连模型，档位是 pi/dsh 各自内核的概念）。**显式声明**而不是留空——
// 旗标是"有没有这个面"的诚实回答，不是"先随便给个 true"。
// 不声明任何私有频道（与 pi/dsh 同款）：默认模型变更走框架中性信号 system:refreshRequested。
import { ModelConfigPage, usePluginContext, type SettingsComponentProps } from "@my-harness-desktop/react";

export function Probe4ModelsPage(props: SettingsComponentProps): React.ReactNode {
  const ctx = usePluginContext();
  return (
    <ModelConfigPage
      api={ctx.kernelModels.probe4}
      i18nPrefix="probe4Models"
      capabilities={{ reasoning: false, developerRole: false }}
      config={props.config}
      dirty={props.dirty ?? false}
      onChange={props.onChange}
    />
  );
}
