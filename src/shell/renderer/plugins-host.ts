// plugins-host —— 加载内置插件 renderer 模块,触发其自注册。
//
// 阶段 F(H2):用 import.meta.glob 动态加载所有内置插件 renderer,不再硬编码
// import 哪个插件。新增内置插件自动被发现(只要在 src/plugins/*/renderer/)。
//
// 内置插件平等:同一 glob 扫描,无 if(builtin) 分支。
// ⚠ 第三方插件(用户级 ~/.pi-desktop/plugins)renderer 运行时动态 import 需
// import map(文档 18 §6.2),本次不做——第三方插件设置页配置项暂不渲染其
// 自定义 component(只能渲染内置贡献的 component 名)。后续补 import map。
// 加载内置插件 renderer 触发其调 registerSettingsComponent 注册配置页组件。
const modules = import.meta.glob("../../../plugins/*/renderer/index.{ts,tsx}");
for (const path of Object.keys(modules)) {
  void modules[path]();
}
