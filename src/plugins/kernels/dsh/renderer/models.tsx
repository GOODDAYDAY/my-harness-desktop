// dsh 内核插件 renderer ——「DSH 入口 · DSH 模型」TAB（薄 wrapper）。
//
// 模型配置走共享 base ModelConfigPage（kernel-design-spec.md §12.5）。dsh 的能力旗标：
// reasoning=true(dsh-thinking-level.md §5:reasoning 标记写回 settings.yaml 时展开成
// reasoningEfforts 档位映射,dsh 会话的思考档位切换自此可对模型逐条声明)。
// 数据/保存走框架（config/onChange/dirty 由 SettingsPage 注入），本 wrapper 只填 spec。
// **不再声明私有频道**（与 pi 侧同款，理由见 pi/renderer/models.tsx 注释）：
// "默认模型变了"由 main 侧广播中性信号 system:refreshRequested，各内核不再各占一个频道。
import { ModelConfigPage, usePluginContext, type SettingsComponentProps } from "@my-harness-desktop/react";

export function DshModelsPage(props: SettingsComponentProps): React.ReactNode {
  const ctx = usePluginContext();
  return (
    <ModelConfigPage
      api={ctx.kernelModels.dsh}
      i18nPrefix="dshModels"
      capabilities={{ reasoning: true }}
      config={props.config}
      dirty={props.dirty ?? false}
      onChange={props.onChange}
    />
  );
}
