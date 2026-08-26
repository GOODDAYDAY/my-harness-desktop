// 内核身份标(logo)的 renderer 侧 store —— 启动时从 main 经 IPC 取回一次(静态数据,
// 读多写少),组件(KernelLogo)同步读。内核 logo 由内核自己在 client/{kernel} 声明,
// 壳只取回渲染,不硬编码 path(机制与内容分离)。

import { create } from "zustand";
import { KERNEL_IDS, type KernelId, type KernelLogo } from "@my-harness-desktop/shared";

interface KernelLogosState {
  logos: Record<KernelId, KernelLogo | null>;
}

export const useKernelLogos = create<KernelLogosState>(() => ({
  logos: { pi: null, dsh: null },
}));

/** 取回全部内核 logo 进 store(启动时调一次;失败保持 null,组件自回落)。 */
export function initKernelLogos(): void {
  for (const kernel of KERNEL_IDS as readonly KernelId[]) {
    void window.kernel.kernelLogos
      .get(kernel)
      .then((logo) => {
        useKernelLogos.setState((s) => ({ logos: { ...s.logos, [kernel]: logo } }));
      })
      .catch(() => { /* main 未就绪等;保持 null,KernelLogo 组件回退占位 */ });
  }
}
