// 内核身份标(logo)注册表 —— 把各内核在自己适配器里声明的 logo 绑成一份按 KernelId
// 键控的映射。组装归 bootstrap:import client(logo 数据)+ domain(契约),api/ipc 经
// MainContext 注入消费,不直连 client。
//
// 加第三个内核 = client 里再交一个 logo 数据 + 这里加一行映射,壳的渲染(KernelLogo)
// 一行不改。

import type { KernelId, KernelLogo } from "../../core/domain/kernel";
import { PI_LOGO } from "../../client/pi/pi-logo";
import { DSH_LOGO } from "../../client/dsh/dsh-logo";

/** 全部内核的 logo,按 KernelId 键控(pi/dsh)。 */
export const KERNEL_LOGOS: Record<KernelId, KernelLogo> = {
  pi: PI_LOGO,
  dsh: DSH_LOGO,
};

/** 按内核 id 取 logo(未知 id 无对应——但 KernelId 是字面量联合,穷尽)。 */
export function getKernelLogo(kernel: KernelId): KernelLogo {
  return KERNEL_LOGOS[kernel];
}
