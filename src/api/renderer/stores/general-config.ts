// general.json 分层读写 helper —— renderer 壳层,框架级文件的统一通道语义入口。
//
// 依据 docs/design/unified-project-config.md §5.4:general.json 与插件配置同套
// 两层 fallback——项目级 <cwd>/.my-harness-desktop/config/general.json 覆盖全局
// ~/.my-harness-desktop/config/general.json(顶层 key 浅合并,项目级只存 diff)。
// 消费方(layout-store/right-panel/ui-store)不各自拼路径,统一走这里;
// 写后广播 system:configFileSaved,订阅方(ui-store.generalConfig)重读。
import { GENERAL_CONFIG_PATH } from "@my-harness-desktop/contract";
import { eventBus } from "../../../../packages/react/src/event-bus";

/** relPath 对齐键:全局 ~/.my-harness-desktop/config/general.json ↔ 项目级 <cwd>/.my-harness-desktop/config/general.json */
const GENERAL_REL = "config/general.json";

// 当前 cwd 的模块级镜像:ui-store 在 setCurrentCwd/hydrate 时写入。
// 存在理由:layout-store 需要 cwd 读写本文件,但 layout-store ↔ ui-store 互相 import
// (zustand 顶层 create),直接 import useUiStore 会成显式循环依赖;镜像解耦。
let currentCwdMirror = "";
export function setGeneralConfigCwd(cwd: string): void {
  currentCwdMirror = cwd;
}

/** 分层读:有 cwd 走两层 key 级合并;无 cwd 全局层是唯一的家。两层都无返回空对象。 */
export async function readGeneralConfig(cwd?: string): Promise<Record<string, unknown>> {
  const dir = cwd ?? currentCwdMirror;
  if (!dir) return window.pi.configFile.get(GENERAL_CONFIG_PATH);
  return (await window.pi.configFile.getLayered(dir, GENERAL_REL)) ?? {};
}

/** 分层写:deep 合并进项目级(有 cwd)或全局层(无 cwd);写后广播 configFileSaved。 */
export async function writeGeneralConfig(patch: Record<string, unknown>, cwd?: string): Promise<void> {
  const dir = cwd ?? currentCwdMirror;
  if (!dir) await window.pi.configFile.set(GENERAL_CONFIG_PATH, patch, "deep");
  else await window.pi.configFile.setProject(dir, GENERAL_REL, patch, "deep");
  eventBus.emitSystem("system:configFileSaved", { path: GENERAL_CONFIG_PATH });
}
