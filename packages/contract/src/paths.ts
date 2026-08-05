/** 桌面级通用配置文件路径(general 设置:debugMode / sidebarDefaultOpen 等)。
 *  契约单源:general-config 插件拥有此文件,其余消费方(debug-bar / timeline / ui-store)
 *  统一引用此常量,不再各自写字面量。manifest 的 configFile 字段是 JSON 声明,无法 import,
 *  仍保留同值字面量——改路径时两处同步。 */
export const GENERAL_CONFIG_PATH = "~/.pi-desktop/config/general.json";

/** pi 底座模型配置文件路径(provider/模型清单,底座标准契约,两版数据根共享不分流)。
 *  契约单源:pi-model-manager 插件拥有此文件(manifest configFile 是 JSON 声明,同值字面量),
 *  其余消费方(timeline 的 configFileSaved 重读判据)统一引用此常量。 */
export const MODELS_CONFIG_PATH = "~/.pi/agent/models.json";
