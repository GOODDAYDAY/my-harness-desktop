// 圆心:channel 元数据契约 —— 事件总线 channel 的可读描述。
//
// 为什么需要:快捷键/命令面板类插件要"动态列出全部可用事件",只有 channel 名
// 对用户不可读(看到 timeline:scrollTo 不知道干嘛)。各插件以 channelMeta 可选导出
// 声明描述,框架加载时收集,eventBus 提供枚举接口暴露给消费方。
//
// 零依赖纯类型:不 import react/electron/pi(圆心纯度纪律,§6.1)。
// 契约单源(§1.3):类型只在圆心定义,packages/contract 纯 re-export。

/** channel 的可读描述(插件可选导出,增强而非门槛——不声明则回退显示 channel 名)。
 *
 *  ⚠ 文案字段是 **i18n 键**，不是文本（r55 改）。此前这里写的是
 *  「文案归插件自持有，**直接写文本或走 i18n 均可**」——那句"均可"就是债务的批准书：
 *  8 个通道里有 8 个都直接写了中文，于是 en / de / zh-TW 用户在键位绑定页看到中文，
 *  而 `shell-no-hardcoded-copy` 的债务棘轮里长期挂着这 20 处。
 *  改成 `labelKey` 之后"直接写文本"在**字段名上就说不通**（消费方一律 `t(key)`），
 *  并且可以用守卫核对"每个声明的键在四个语言里都存在"。
 *  形态与本仓既有的 `ThemeContribution.labelKey` / `FontPresetContribution.labelKey` 一致。 */
export interface ChannelMeta {
  /** 人类可读短名的 **i18n 键**(列表展示;缺省回退显示 channel 名)。 */
  labelKey?: string;
  /** 用法说明的 **i18n 键**(含 payload 形状/含义,设置页展示)。 */
  descriptionKey?: string;
  /** payload 示例(设置页预填 JSON 编辑框,用户改后保存)。 */
  payloadExample?: unknown;
  /** 会话作用域(设计 docs/design/session-scope.md §2.5)。
   *
   *  "session":框架在 emit 时自动注入作用域坐标、on 时按坐标过滤投递、replayLast 按坐标
   *  分桶回放。缺省 "global" = 现有行为完全不变(跨会话的命令类 channel 本就不该被过滤)。
   *
   *  为什么由框架注入而不是让插件在 payload 里自己带会话 id:靠自觉等于靠不住——
   *  goal 的 goal:state 就是没带的那个,而它同一份文件里写了几十行手动隔离逻辑。
   *  注入后插件物理上不可能漏(CLAUDE.md §1.1「执行不靠自觉,靠物理隔离」)。
   *  且 replayLast 的分桶是总线内部的存储结构问题,插件带不带坐标都改变不了
   *  「lastPayload 每 channel 一份」这个事实——这一半只能由总线自己修。
   *
   *  payload 形状对插件透明:emit/on 两侧的签名与数据都不变,坐标是传输层的信封。 */
  scope?: "session" | "global";
}

/** eventBus.listChannels() 的返回项:channel + 归属插件 + 可读描述。 */
export interface ChannelInfo {
  channel: string;
  pluginId: string;
  meta?: ChannelMeta;
}
