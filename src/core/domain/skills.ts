// 圆心:技能中立契约 —— domain/skills,零依赖。
//
// 依据 docs/design/skills-layering.md:壳只认 SkillProvider 接口 + 中性 SkillInfo,
// 不读任何内核存储。扫目录/读配置/解析 frontmatter 全是内核侧(pi 扩展、dsh 插件)的事,
// 内核经 SkillProvider 回报完整列表(含禁用)、接收开关意图。加第三个内核 = 加一个 SkillProvider 实现,
// 壳一行不改。

/** 能力标志:本内核支持哪几根开关轴,壳据此渲染开关、不硬编码内核身份。 */
export interface SkillCapabilities {
  /** 是否支持"加载/卸载"轴(pi 原生有;dsh 经插件补,未补前报 false)。 */
  toggleEnabled: boolean;
  /** 是否支持"模型可自动调用"轴(两边都有)。 */
  toggleModelInvocable: boolean;
  /** 是否支持"用户可 /skill 调用"轴(dsh 有;pi 无)。 */
  toggleUserInvocable: boolean;
}

/** 中性技能:三根轴归一成正向布尔 + 来源透传。壳只认这个形状。 */
export interface SkillInfo {
  /** 技能名(frontmatter name,内核解析后回报)。 */
  name: string;
  /** 描述(frontmatter description)。 */
  description: string;
  /** 作用域:全局(user) 还是当前项目(project)。 */
  scope: "user" | "project";
  /** 加载与否(pi 的 +/-、dsh 的 disabled 名单,归一成这一个布尔)。 */
  enabled: boolean;
  /** 模型可否自动调用(frontmatter disable-model-invocation 的反值)。 */
  modelInvocable: boolean;
  /** 用户可否 /skill 调用(frontmatter user-invocable,dsh 有、pi 恒 true)。 */
  userInvocable: boolean;
  /** 来源标签,由内核适配器在翻译时填入,壳原样显示、不写死。 */
  source?: string;
  /** SKILL.md 绝对路径(开关操作定位用)。 */
  filePath?: string;
}

/** 技能域的中立契约:壳和内核之间的统一接口(和 BaseBackend 同构)。 */
export interface SkillProvider {
  /** 本内核支持哪几根开关轴。 */
  readonly capabilities: SkillCapabilities;
  /** 读完整技能列表(含禁用),供管理页展示。 */
  listSkills(cwd: string): Promise<SkillInfo[]>;
  /** 加载/卸载(对应 enabled 轴)。 */
  setEnabled(skill: SkillInfo, enabled: boolean): Promise<void>;
  /** 模型可自动调用(对应 modelInvocable 轴)。 */
  setModelInvocable(skill: SkillInfo, value: boolean): Promise<void>;
  /** 用户可 /skill 调用(对应 userInvocable 轴)。 */
  setUserInvocable(skill: SkillInfo, value: boolean): Promise<void>;
  /** 订阅技能变化(内核回报,壳重拉列表)。 */
  watch(cwd: string, onChanged: () => void): () => void;
}
