// 局域网 IPv4 探测(web-service §23.3)——node:os.networkInterfaces 取非 internal 的 IPv4。
// 供 remote:status / QR 显示局域网地址。依赖只向内:node:os。

import { networkInterfaces } from "node:os";

/** 返回本机所有局域网 IPv4 地址(去 internal/去重)。无则空数组。 */
export function getLanAddresses(): string[] {
  const out = new Set<string>();
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === "IPv4" && !iface.internal) out.add(iface.address);
    }
  }
  return [...out];
}
