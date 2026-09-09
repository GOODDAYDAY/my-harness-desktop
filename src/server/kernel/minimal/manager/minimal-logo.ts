// minimal 内核身份标(logo)—— minimal 内核自己在适配器里声明的 SVG 数据。
//
// 与 pi-logo / dsh-logo 对称:内核交序列化 logo 数据,壳不硬编码 path(机制与内容分离)。
// minimal 的标取「圆环」(annulus)—— 极简、自洽,一个空心的点。

import type { KernelLogo } from "@my-harness-desktop/shared";

/** minimal 内核标:○ 圆环 mark(viewBox 0 0 24 24),单 path、currentColor、evenodd。 */
export const MINIMAL_LOGO: KernelLogo = {
  viewBox: "0 0 24 24",
  label: "minimal",
  paths: [
    {
      d: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm0 4.5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9z",
      fillRule: "evenodd",
    },
  ],
};
