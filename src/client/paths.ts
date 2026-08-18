// 桌面数据根路径单源 —— 打包态 ~/.my-harness-desktop,dev 态 ~/.my-harness-desktop-dev。
//
// 为什么分流:打包安装的是稳定版,npm run dev 跑的是迭代版。两版共享同一份数据目录时,
// 不稳定版的配置结构变更/迁移 bug 会污染稳定版数据。数据根按 app.isPackaged 分流,
// 代码层(dev 跑新代码)和数据层(dev 用 -dev 目录)的隔离边界对齐。
//
// "逻辑前缀"契约:插件 manifest 和 renderer 声明的 ~/.my-harness-desktop/... 不是物理路径,
// 是逻辑前缀,运行时经 expandDesktopPath 映射到当前数据根——契约不变,物理落点随
// 打包态分流。configFile/session 通道的白名单与展开都走这一个函数(契约单源)。
//
// 不分流的:~/.pi/agent(pi 底座标准目录,模型 key 等,两版共享)、
// 项目级 <cwd>/.my-harness-desktop/(跟着项目走,不属于桌面数据根)。
import { app } from "electron";
import { homedir } from "node:os";
import { join } from "node:path";

const DESKTOP_DIR_NAME = ".my-harness-desktop";
const DESKTOP_DEV_DIR_NAME = ".my-harness-desktop-dev";

/** 当前运行态的桌面数据根目录(打包态 ~/.my-harness-desktop,dev 态 ~/.my-harness-desktop-dev)。 */
export function resolveMyHarnessDesktopDir(): string {
  return join(homedir(), app.isPackaged ? DESKTOP_DIR_NAME : DESKTOP_DEV_DIR_NAME);
}

/** 逻辑前缀展开:`~/.my-harness-desktop(/...) 映射到当前数据根;其余 ~/ 映射到家目录;绝对路径原样。
 *  homeDir/myHarnessDesktopDir 由调用方(MainContext.paths)传入,本函数不重复读环境(纯函数)。 */
export function expandDesktopPath(p: string, homeDir: string, myHarnessDesktopDir: string): string {
  const logical = `~/${DESKTOP_DIR_NAME}`;
  if (p === logical) return myHarnessDesktopDir;
  if (p.startsWith(logical + "/")) return join(myHarnessDesktopDir, p.slice(logical.length + 1));
  if (p.startsWith("~/")) return join(homeDir, p.slice(2));
  return p;
}
