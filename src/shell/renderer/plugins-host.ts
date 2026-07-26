// plugins-host —— 加载内置插件 renderer 模块,触发其自注册。
//
// 阶段 F(H2):用 import.meta.glob eager 加载所有内置插件 renderer,不再硬编码
// import 哪个插件。eager=true 在 build 期静态内联(同步),避免异步加载导致
// 组件注册时序竞态(回归根因:异步 glob 时 settings-page 渲染时组件未注册 → 右边空白)。
// 新增内置插件自动被发现(只要在 src/plugins/*/renderer/)。
//
// 内置插件平等:同一 glob 扫描,无 if(builtin) 分支。
// ⚠ 第三方插件(用户级 ~/.pi-desktop/plugins)renderer 运行时动态 import 需
// import map(文档 18 §6.2),本次不做——第三方插件设置页配置项暂不渲染其
// 自定义 component。后续补 import map。
// 路径:plugins-host 在 src/shell/renderer/,../../ = src,/plugins = src/plugins
import.meta.glob("../../plugins/*/renderer/index.{ts,tsx}", { eager: true });
