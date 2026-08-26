// 二维码生成(web-service §23.3/§38)——qrcode 包,输出 data URL(base64 PNG)。
// 供 remote:qr 返回给设置页展示局域网/公网地址。依赖只向内:qrcode。

import QRCode from "qrcode";

/** 把 URL 生成二维码 data URL(240px,留白 1)。 */
export function generateQr(url: string): Promise<string> {
  return QRCode.toDataURL(url, { width: 240, margin: 1 });
}
