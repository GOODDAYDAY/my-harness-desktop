// 线协议序列化(web-service-architecture.md §17/§32)。
// 纯函数、零依赖——JSON 是传输细节,这里的职责是「文本 ↔ WireMessage」的边界校验。
// 不 import ws/http/electron。

import type { WireMessage } from "../domain/remote";

/** 把一段 JSON 文本解析成 WireMessage。格式非法(非对象/无 kind)抛错,由 ws-server 捕获关闭连接。 */
export function parseWire(text: string): WireMessage {
  const m = JSON.parse(text) as WireMessage;
  if (m === null || typeof m !== "object" || typeof m.kind !== "string") {
    throw new Error("bad wire message: 缺 kind");
  }
  return m;
}

/** 把 WireMessage 序列化成 JSON 文本。 */
export function serializeWire(msg: WireMessage): string {
  return JSON.stringify(msg);
}
