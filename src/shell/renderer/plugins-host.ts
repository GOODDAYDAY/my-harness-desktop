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
//
// 机械防回归:Vite 对空 glob 静默不报(路径错会无声漏过),故此处显式断言
// 匹配数 > 0——glob 路径写错/插件 renderer 全删时,build 或运行期立即抛错,
// 而非静默"右边空白"。
const modules = import.meta.glob("../../plugins/*/renderer/index.{ts,tsx}", { eager: true });
if (Object.keys(modules).length === 0) {
  throw new Error(
    "[plugins-host] glob 匹配 0 个内置插件 renderer,路径可能写错(应在 src/plugins/*/renderer/index.tsx)",
  );
}
void modules; // eager 模式副作用已加载,这里引用避免 lint unused

