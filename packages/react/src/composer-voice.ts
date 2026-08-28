// composerVoice 槽的 renderer 侧查询 hook(机械镜像 useComposerTop:
// 同 nonce 单发,失效重拉)。消费方(timeline)查槽后按 getPluginComponent 匹配组件,
// 渲染进 Composer 右下角(原语音占位按钮的位置)。
//
// 与其它 composer* 槽的区别:本槽组件带 props(onTranscribed 回调)——语音转文字的结果
// 要写回输入框,不能靠组件自订阅 store 完成,故由消费方(timeline)注入回调。贡献方只
// 负责「采集 + 转写 + 报告文字」,「写进哪个输入框」由挂载点决定。
import { useEffect, useState } from "react";
import type { ComposerVoiceContribution } from "@my-harness-desktop/shared";
import { useUiStore } from "../../../src/web/stores/ui-store";

export type ComposerVoiceItem = ComposerVoiceContribution & { pluginId: string };

/** 槽组件 props 契约:转写完成回调(把文字写进输入框,追加语义,用户改后手动发送)。
 *  disabled 由消费方传入(输入框只读/未就绪时禁用);无贡献时 composer 自画禁用占位。 */
export interface ComposerVoiceProps {
  /** 转写完成回调:把识别文字写进输入框(追加语义,已有草稿不被顶掉)。 */
  onTranscribed: (text: string) => void;
  /** 输入框不可用(未选项目/未装内核)时由消费方传入禁用。 */
  disabled?: boolean;
}

let cache: { nonce: number; data: ComposerVoiceItem[] } | null = null;

/** 查 composerVoice 槽全部贡献(语音按钮组件,首个贡献胜出;同 nonce 单发,失效重拉)。 */
export function useComposerVoice(): ComposerVoiceItem[] {
  const pluginsNonce = useUiStore((s) => s.pluginsNonce);
  const [data, setData] = useState<ComposerVoiceItem[]>(
    () => (cache && cache.nonce === pluginsNonce ? cache.data : []),
  );
  useEffect(() => {
    let alive = true;
    void window.kernel.slots.composerVoice().then((d) => {
      cache = { nonce: pluginsNonce, data: d };
      if (alive) setData(d);
    });
    return () => { alive = false; };
  }, [pluginsNonce]);
  return data;
}
