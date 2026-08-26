// 圆心:channel 元数据契约 —— 事件总线 channel 的可读描述。
//
// 为什么需要:快捷键/命令面板类插件要"动态列出全部可用事件",只有 channel 名
// 对用户不可读(看到 timeline:scrollTo 不知道干嘛)。各插件以 channelMeta 可选导出
// 声明描述,框架加载时收集,eventBus 提供枚举接口暴露给消费方。
//
// 零依赖纯类型:不 import react/electron/pi(圆心纯度纪律,§6.1)。
// 契约单源(§1.3):类型只在圆心定义,packages/contract 纯 re-export。

/** channel 的可读描述(插件可选导出,增强而非门槛——不声明则回退显示 channel 名)。 */
export interface ChannelMeta {
  /** 人类可读的短名(列表展示)。文案归插件自持有,直接写文本或走 i18n 均可。 */
  label?: string;
  /** 用法说明(含 payload 形状/含义,设置页展示)。 */
  description?: string;
  /** payload 示例(设置页预填 JSON 编辑框,用户改后保存)。 */
  payloadExample?: unknown;
}

/** eventBus.listChannels() 的返回项:channel + 归属插件 + 可读描述。 */
export interface ChannelInfo {
  channel: string;
  pluginId: string;
  meta?: ChannelMeta;
}
