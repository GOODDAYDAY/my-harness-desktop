// pi 内核身份标(logo)—— pi 内核自己在适配器里声明的 SVG 数据。
//
// 依据 CLAUDE.md §1.2 机制与内容分离:logo path 是「内容」(会变、内核自有),
// 不该硬编码在壳(packages/react/plugin-icon)。内核交的 logo 是序列化数据,不是 React
// 组件(client 层不 import react)。壳只做通用渲染(KernelLogo),经 IPC 取回这份数据。

import type { KernelLogo } from "../../core/domain/kernel";

/** pi 内核标:⬡ 几何标(viewBox 0 0 800 800),两条 path 合成。 */
export const PI_LOGO: KernelLogo = {
  viewBox: "0 0 800 800",
  label: "pi",
  paths: [
    {
      d: "M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29Z M282.65 282.65V400H400V282.65Z",
      fillRule: "evenodd",
    },
    { d: "M517.36 400H634.72V634.72H517.36Z" },
  ],
};
