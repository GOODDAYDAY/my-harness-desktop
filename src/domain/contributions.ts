// 圆心:槽位贡献项类型契约。
//
// 依据 DESIGN.md §3.3(八槽契约)。这是圆心拥有的稳定契约——
// 各槽位贡献项的形状在此定义,加载器按它校验,渲染层按它消费。
// 零外部依赖:不 import react/electron/pi(圆心纯度纪律,structure/16 §10.1)。

/** 设置子页槽(settings)贡献项:插件自己的配置页(DESIGN.md §3.3 / 952 行)。 */
export interface SettingsContribution {
  /** 配置页 id,设置页左列表项标识 */
  id: string;
  /** 配置页标题,设置页左列表显示 */
  title: string;
  /** renderer 侧组件名,设置页按名映射到对应组件渲染 */
  component: string;
}

/** 主题槽(themes)贡献项(06 §4.1 ThemeContribution 镜像,圆心拥有)。 */
export interface ThemeContribution {
  id: string;
  name: string;
  tokens: Record<string, string>;
  base?: string;
}

/** SlotName:八槽名(DESIGN.md §3.3)。 */
export type SlotName =
  | "languages"
  | "themes"
  | "management"
  | "cardRenderers"
  | "sidePanel"
  | "viewers"
  | "commands"
  | "settings";
