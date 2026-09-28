// 选目录的**统一原语**（r137，§3.3「框架管通用」；与 r134 的 copyToClipboard 同款处置）。
//
// ## 为什么要有它
//
// r136 修了 stickers 的 pickBanner（`ctx.dialog.openImages()` 裸奔）之后，
// 用"账本里 acceptable 的理由在**每一种宿主**下都成立吗"这把尺子重审账本，
// 发现 `ctx.dialog.*` 一族的理由**全都默认了本地 Electron 宿主**：
//   · `openZip`：『真失败时系统对话框自身会报错』——远程/浏览器宿主下对话框能力是
//     `UNSUPPORTED_HOST`，**系统对话框根本没打开**，没有任何东西会替它报错；
//   · `writeImages`：『导出失败 ⇒ 无文件产出，用户会立刻发现』——远程下点了导出
//     什么都没发生，用户只会以为"没反应"；
//   · `openDirectory`：『真失败时对话框自身会报错』——同 openZip。
// 而实测 `ctx.dialog.openDirectory()` 有 **3 处渲染层用户动作**在裸 await
// （projects 的"打开目录"、plugin-manager 的"浏览"、kernel-version-page 的"浏览"），
// 三处做的是同一件事 ⇒ 按 §3.3 收敛成一个原语，而不是三处各加一个 try/catch。
//
// ## 契约
//
// 返回 `string | null`：`null` 同时表示"用户取消"与"能力不可用/失败"——
// 调用方对两者的正确反应是一样的（什么都不做）。**失败时本函数自己播报**
// （announceTransient，role=alert 可打断），所以调用方不必再管提示；
// 而"用户取消"**不播报**（取消是正常操作，播报反而是噪音）。
// 不抛：调用方多在 onClick 里，抛出去就是 unhandled rejection（r80/r134 的同款问题）。
import { i18next } from "../../../../src/web/app/i18n-init";
import { announceTransient } from "./live-region";

/** 只需要这一个能力面，所以用结构化最小类型（不把整个 PluginContext 拖进来）。 */
export interface DirectoryPicker {
  dialog: { openDirectory(): Promise<string | null> };
}

/** 打开系统目录选择器。用户取消或失败都返回 null；**失败会播报原因**（取消不播报）。 */
export async function pickDirectory(ctx: DirectoryPicker): Promise<string | null> {
  try {
    return await ctx.dialog.openDirectory();
  } catch (err) {
    const detail = (err as Error)?.message ?? String(err);
    // UNSUPPORTED_HOST 是远程/浏览器宿主的确定性结果，给用户**可执行的下一步**（§7.6：降级要解释）
    announceTransient(i18next.t("shell.directoryPickerFailed", { detail }), "error");
    return null;
  }
}
