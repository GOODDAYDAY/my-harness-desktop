// 圆心:技能(Skill)中性契约 —— domain/skills,零外部依赖。
//
// Skill 是 pi 底座的资源(SKILL.md + frontmatter),pi-desktop 扫描、展示、启用/禁用。
// 本文件只定义中性类型契约,扫描实现 in application/skills/skill-scanner.ts(用例编排),
// UI in plugins/skill-manager(内容层)。依赖只向内:scanner import domain,反向不可。
//
// 依据 docs/plugins/skill-manager.md。

/** 扫描到的单个技能信息(扫描 ~/.pi/agent/skills、~/.agents/skills、<cwd>/.pi/skills 等 + settings.json skills 数组)。 */
export interface SkillInfo {
  /** 技能名(frontmatter name;缺省取文件名 stem)。 */
  name: string;
  /** 描述(frontmatter description)。 */
  description: string;
  /** SKILL.md 文件绝对路径。 */
  filePath: string;
  /** 技能所在目录(技能可能多文件,baseDir 是根)。 */
  baseDir: string;
  /** settings.json skills 数组里声明的源路径(可能是目录或文件,与 filePath 区分)。 */
  sourcePath: string;
  /** 来源类型:settings(显式声明在 settings.json skills 数组)/ auto(目录扫描自动发现)。 */
  sourceType: "settings" | "auto";
  /** 作用域:user(~/.pi/agent/settings.json)/ project(<cwd>/.pi/settings.json)。 */
  scope: "user" | "project";
  /** 是否启用(override 模式:+ 前缀 enabled、- 前缀 disabled、无前缀按 sourceType/default)。 */
  enabled: boolean;
  /** frontmatter disable-model-invocation(模型不可主动调用,只能用户显式触发)。 */
  disableModelInvocation: boolean;
  /** filePath 是否符号链接。 */
  isSymlink: boolean;
  /** 符号链接的真实路径(非链接时等于 filePath)。 */
  realPath: string;
}

/** 扫描选项(scanner 实现侧用,domain 定义契约,application 实现注入路径)。 */
export interface ScanOptions {
  /** pi 底座根目录(~/.pi/agent,shell 注入,scanner 不直读 process.env)。 */
  agentDir: string;
  /** 当前工作目录(项目级 skills 扫描用)。 */
  cwd: string;
}
