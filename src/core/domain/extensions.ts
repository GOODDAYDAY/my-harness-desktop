// 圆心:extension 管理类型契约 + 重启协调器接口 —— domain,零依赖。
//
// 依据 docs/core/extension-management.md §4.1(ExtensionInfo)、§3.2(RestartCoordinator)。
// 圆心只定义类型和接口,实现在 application 层。
// 零外部依赖:不 import react/electron/pi(圆心纯度纪律)。

/** extension 来源类型(§4.1)。 */
export type ExtensionSource = "file" | "local" | "npm" | "git";

/** extension 在列表中的呈现信息(§4.1)。 */
export interface ExtensionInfo {
  source: string;
  name: string;
  version?: string;
  description?: string;
  sourceType: ExtensionSource;
  enabled: boolean;
  origin: "extensions-dir" | "settings-packages";
  disallowOff?: boolean;
}
