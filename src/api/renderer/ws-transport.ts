// 前端 WS 传输(web-service-architecture.md §15/§32)——RemoteTransport 三原语 + wsTransport。
// window.kernel 永远由 buildKernel(wsTransport(ws), host) 构建,不存在「宿主注入」(§4.4)。
//
// 依赖只向内:本文件是 api/renderer 的流入适配器,只 import core/domain 的线协议类型 +
// core/application 的 wire 序列化,不 import electron(渲染层零 Electron)。

import type { WireMessage } from "../../core/domain/remote";
import { parseWire, serializeWire } from "../../core/application/remote/wire";

/** 前端与后端的唯一传输抽象(§15.1),只有三个原语。
 *  返回/回调用 any 对齐原 ipcRenderer.invoke/on 的松类型——buildKernel 里各 typed 方法
 *  (Promise<boolean>/Promise<string[]> 等)直接 assignable,不必逐方法断言。 */
export interface RemoteTransport {
  /** 发一个请求,等后端应答。channel 是 §18 清单名,args 是位置参数。 */
  invoke(channel: string, ...args: unknown[]): Promise<any>;
  /** 订阅一个推送 channel。返回取消函数(幂等)。 */
  on(channel: string, cb: (...args: any[]) => void): () => void;
  /** 取消订阅。cb 必须是 on 时传入的同一引用。 */
  off(channel: string, cb: (...args: any[]) => void): void;
}

/** 挂起的 invoke 配对(§15.5)。 */
interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
}

/** 把 WebSocket 包装成 RemoteTransport(§32.1)。id 自增,按 id 配对 result;push 按 channel 派发。 */
export function wsTransport(ws: WebSocket): RemoteTransport {
  let seq = 0;
  const pending = new Map<number, Pending>();
  const subs = new Map<string, Set<(...a: any[]) => void>>();

  ws.addEventListener("message", (ev) => {
    let m: WireMessage;
    try {
      m = parseWire(String(ev.data));
    } catch {
      return; // 坏帧忽略(不炸传输)
    }
    if (m.kind === "result") {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.ok) p.resolve(m.result);
      else p.reject(new Error(m.error?.message ?? "remote error"));
    } else if (m.kind === "push") {
      for (const cb of subs.get(m.channel) ?? []) cb(...(m.args ?? []));
    }
  });

  return {
    invoke(channel, ...args) {
      const id = ++seq;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(serializeWire({ kind: "invoke", id, channel, args }));
      });
    },
    on(channel, cb) {
      let set = subs.get(channel);
      if (!set) { set = new Set(); subs.set(channel, set); }
      set.add(cb);
      return () => set.delete(cb);
    },
    off(channel, cb) {
      subs.get(channel)?.delete(cb);
    },
  };
}
