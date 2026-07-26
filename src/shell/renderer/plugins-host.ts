// plugins-host —— 加载内置插件 renderer 模块,触发其自注册。
//
// ⚠ 已知架构缺口(盲审 H1/H2/H3,演进待修):
// 1. 真加载器应发现 project/user/installed/builtin 多目录插件(本次只扫 builtin,
//    第三方插件目前无法被发现,H3)。
// 2. 真加载器应按 manifest.renderer 动态 import 插件 renderer(本次静态 import 一个,
//    不通用,H2)。
// 3. 插件 renderer 不应直连 shell 内层(@/shell/renderer/...),应经 @pi-desktop/react
//    受控 API(H1)——当前该包不存在,暂用 @ alias,演进建 @pi-desktop/react 包解决。
// 本次保留为验证可见链路的最小通路,标注备查。后续加载器落地后改为动态发现 + 受控 API。
import "@/plugins/theme-manager/renderer";
import "@/plugins/pi-kernel-manager/renderer";
