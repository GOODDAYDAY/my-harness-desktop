// 圆心:extension 管理类型契约 + 重启协调器接口 —— domain,零依赖。
//
// 依据 docs/core/extension-management.md §4.1(ExtensionInfo)、§3.2(RestartCoordinator)。
// 圆心只定义类型和接口,实现在 application 层。
// 零外部依赖:不 import react/electron/pi(圆心纯度纪律)。

/** extension 来源类型(§4.1)。 */
export type ExtensionSource = "file" | "local" | "npm" | "git";

/** extension 在列表中的呈现信息(§4.1)。 */
export interface ExtensionInfo {
  /** source 字符串(文件路径、目录路径、npm spec、git URL) */
  source: string;
  /** 从 package.json 解析出的名称,loose .ts 文件用文件名 */
  name: string;
  /** 版本号,loose .ts 文件无 */
  version?: string;
  /** 描述,从 package.json description 字段 */
  description?: string;
  /** 来源类型 */
  sourceType: ExtensionSource;
  /** 是否启用 */
  enabled: boolean;
  /** 来源目录:extensions/ 目录还是 settings.json packages */
  origin: "extensions-dir" | "settings-packages";
}
