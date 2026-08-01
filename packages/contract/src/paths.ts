/** 桌面级通用配置文件路径(general 设置:debugMode / sidebarDefaultOpen 等)。
 *  契约单源:general-config 插件拥有此文件,其余消费方(debug-bar / timeline / ui-store)
 *  统一引用此常量,不再各自写字面量。manifest 的 configFile 字段是 JSON 声明,无法 import,
 *  仍保留同值字面量——改路径时两处同步。 */
export const GENERAL_CONFIG_PATH = "~/.pi-desktop/config/general.json";
