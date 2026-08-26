// 内核版本管理组装 —— 把具体内核的 spec + postInstall 实现绑成 KernelManager 实例。
//
// 依据 docs/design/kernel-layer.md:组装归 bootstrap(最外层)。本文件 import client
// (具体实现)+ domain(契约),把接口和实现绑起来;core/application 只依赖 KernelManager
// 基类,不 import 本文件。pi/dsh 各一行构造,spec 值由各自实现提供。

import { PiKernelManager, PI_SPEC } from "../pi/manager/pi-kernel";
import { DshKernelManager, DSH_SPEC } from "../dsh/manager/dsh-kernel";

/** pi 内核版本管理实例(装在 ~/.my-harness-desktop/pi)。 */
export function createPiKernelManager(installDir: string): PiKernelManager {
  return new PiKernelManager(PI_SPEC, installDir);
}

/** dsh 内核版本管理实例(装在 ~/.my-harness-desktop/dsh)。 */
export function createDshKernelManager(installDir: string): DshKernelManager {
  return new DshKernelManager(DSH_SPEC, installDir);
}
