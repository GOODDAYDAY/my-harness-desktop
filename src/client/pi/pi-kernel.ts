// pi 内核版本管理实现 —— client/pi 流出适配器(实现层)。
//
// PiKernelManager extends KernelManager(基类):只填 PI_SPEC(数据)+ postInstall(打补丁)。
// 依赖方向只向内:client import core/application(基类)+ core/domain(契约)。
// 内核专属细节(包名/路径段/装后补丁)全在本文件,不泄漏进 core。

import type { KernelSpec } from "@my-harness-desktop/shared";
import { KernelManager } from "../../core/application/kernel/kernel-manager";
import { patchRpcModeForkPosition, patchAgentSessionEntryAppended } from "./patch-rpc-mode";

/** pi 内核 npm 包。 */
export const PI_SPEC: KernelSpec = {
  pkg: "@earendil-works/pi-coding-agent",
  pkgJsonPath: ["node_modules", "@earendil-works", "pi-coding-agent", "package.json"],
  cliWithinPkg: ["dist", "cli.js"],
  srcCli: ["dist", "cli.js"],
  srcPkgJson: ["package.json"],
  cliJsLabel: "dist/cli.js",
};

/**
 * pi 内核版本管理。与 dsh 的唯一行为差异在 postInstall:装/升内核会丢 fork position
 * 与 entry_appended 两个补丁(postinstall 脚本只在仓库 npm install 时跑),须装完重打。
 * already/missing 都不算失败——内核升级天然支持后目标行本就消失。
 */
export class PiKernelManager extends KernelManager {
  protected postInstall(onProgress: (line: string) => void): void {
    const outcome = patchRpcModeForkPosition(this.installDir);
    if (outcome === "patched") onProgress("[patch] rpc-mode.js fork case 已透传 position");
    const eaOutcome = patchAgentSessionEntryAppended(this.installDir);
    if (eaOutcome === "patched") onProgress("[patch] agent-session.js 已补 entry_appended 发射");
  }
}
