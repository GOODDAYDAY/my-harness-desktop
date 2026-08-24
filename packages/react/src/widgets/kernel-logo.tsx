// 内核身份标(logo)渲染 —— 壳的唯一通用渲染器:按 KernelId 取内核自己声明的 SVG
// 数据(client/{kernel} → bootstrap → IPC → store)画出来。壳不硬编码任何内核的 path。
//
// 与 PluginIcon 的关系:PluginIcon 是通用图标解析(lucide + 兜底),内核 id("pi"/"dsh")
// 命中时委托本组件。消费方继续用 PluginIcon name={kernel} 即可,无需感知 logo 数据来源。

import type { CSSProperties, ReactNode } from "react";
import { useKernelLogos } from "../../../../src/api/renderer/stores/kernel-logos";
import type { KernelId, KernelLogo } from "@my-harness-desktop/contract";

/** 按内核 id 同步取 logo 数据(启动已预取;未就绪返回 null)。 */
export function useKernelLogo(kernel: KernelId): KernelLogo | null {
  return useKernelLogos((s) => s.logos[kernel]);
}

/** 渲染内核身份标(⬡/🐋)。logo 未加载完成时返回 null(消费方自行回退)。 */
export function KernelLogo({ kernel, className, style }: {
  kernel: KernelId;
  className?: string;
  style?: CSSProperties;
}): ReactNode {
  const logo = useKernelLogo(kernel);
  if (!logo) return null;
  return (
    <svg viewBox={logo.viewBox} className={className ?? "size-4"} style={style} aria-label={logo.label}>
      {logo.paths.map((p, i) => (
        <path key={i} fill="currentColor" fillRule={p.fillRule ?? "nonzero"} d={p.d} />
      ))}
    </svg>
  );
}
