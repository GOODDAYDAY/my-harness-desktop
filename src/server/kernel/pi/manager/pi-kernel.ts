// pi 内核版本管理实现 —— client/pi 流出适配器(实现层)。
//
// PiKernelManager extends KernelManager(基类):只填 PI_SPEC(数据)。
// 依赖方向只向内:client import core/application(基类)+ core/domain(契约)。
// 内核专属细节(包名/路径段)全在本文件,不泄漏进 core。

import type { KernelSpec } from "@my-harness-desktop/shared";
import { KernelManager } from "../../core/kernel-manager";

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
 * pi 内核版本管理。与 dsh 无行为差异——装后打补丁的 fork position / entry_appended
 * 两个运行时补丁已随内容单源退役(session-single-source §4.4:锚点走中立 entryId,
 * 分叉归壳,壳不再依赖内核的补丁事件)。已装内核上的旧补丁残留无害(壳对多余事件幂等)。
 */
export class PiKernelManager extends KernelManager {}
