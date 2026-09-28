/** 桌面级通用配置文件路径(general 设置:debugMode / sidebarDefaultOpen 等)。
 *  契约单源:general-config 插件拥有此文件,其余消费方(debug-bar / timeline / ui-store)
 *  统一引用此常量,不再各自写字面量。manifest 的 configFile 字段是 JSON 声明,无法 import,
 *  仍保留同值字面量——改路径时两处同步。 */
export const GENERAL_CONFIG_PATH = "~/.my-harness-desktop/config/general.json";

// ⚠ 这里曾有 `MODELS_CONFIG_PATH = "~/.pi/agent/models.json"`——**发布面里写死某个内核的私有路径**，
//   而唯一消费方是通用插件 timeline（拿它比对 `system:configFileSaved` 的 path 来决定要不要重探
//   模型清单）。已删除：语义改由**声明方**给出（设置页按贡献声明派生 `kind`，
//   见 `contract/config-saved.ts`），消费方不再需要知道任何内核的路径。
//   内核自己的模型配置路径仍由各内核插件在 manifest 的 `configFile` 里声明。
