// 前端 WS 传输(web-service-architecture.md §15/§32)——RemoteTransport 三原语 + wsTransport。
// window.kernel 永远由 buildKernel(wsTransport(ws), host) 构建,不存在「宿主注入」(§4.4)。
//
// 依赖只向内:本文件是 api/renderer 的流入适配器,只 import core/domain 的线协议类型 +
// core/application 的 wire 序列化,不 import electron(渲染层零 Electron)。

import type { WireMessage } from "@my-harness-desktop/shared";
import { parseWire, serializeWire } from "@my-harness-desktop/shared";

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

export interface WsTransportOptions {
  /** 本地鉴权 token(§8.3)。给出后传输自己握鉴权:open 先发 hello,鉴权通过前缓冲一切业务帧。
   *  根因:引导期大量 invoke( hydrate/i18n/plugins-host)在模块级发出、早于 WS open;
   *  若 hello 与 invoke 各自排队,连接期缓冲会在 open 时把 invoke 冲在 hello 之前,
   *  网关按「未鉴权」整批拒掉,首屏全部数据面瘫痪(黑屏/加载不出根因)。
   *  hello 收进传输层后,帧序由构造保证,不靠监听器注册顺序。 */
  token?: string;
  /** 连接断开回调(引导层挂「连接已断开」横幅用)。挂起 invoke 仍会显式失败——
   *  此回调只补页面级可见性:断线后输入框还能动但发送无响应,不能静默(第 17 项根因)。 */
  onDisconnect?: () => void;
}

/** 把 WebSocket 包装成 RemoteTransport(§32.1)。id 自增,按 id 配对 result;push 按 channel 派发。 */
export function wsTransport(ws: WebSocket, opts: WsTransportOptions = {}): RemoteTransport {
  let seq = 0;
  let open = false;
  // 无 token = 无 hello 可发,直接就绪;有 token = 等 hello 应答 ok 才放行。
  let authed = !opts.token;
  const outbox: string[] = [];
  const pending = new Map<number, Pending>();
  const subs = new Map<string, Set<(...a: any[]) => void>>();

  const flush = (): void => {
    for (const s of outbox) ws.send(s);
    outbox.length = 0;
  };
  /** 连接断开/鉴权失败:挂起 invoke 一律显式失败——不静默挂死(不伪造成功,也不无限等待)。 */
  const failAll = (message: string): void => {
    for (const [, p] of pending) p.reject(new Error(message));
    pending.clear();
  };

  // 连接期缓冲:CONNECTING 时 ws.send 会抛,先把帧排队;open 后带 token 先发 hello,
  // 鉴权通过才冲刷(§15.6 断线重连的建立段)。
  const send = (s: string): void => {
    if (open && authed) ws.send(s);
    else outbox.push(s);
  };
  ws.addEventListener("open", () => {
    open = true;
    if (opts.token) {
      ws.send(serializeWire({ kind: "hello", token: opts.token }));
    } else {
      flush();
    }
  });
  ws.addEventListener("message", (ev) => {
    let m: WireMessage;
    try {
      m = parseWire(String(ev.data));
    } catch {
      return; // 坏帧忽略(不炸传输)
    }
    if (m.kind === "hello") {
      // S→C 鉴权应答(§6.1):通过 → 冲刷缓冲;失败 → 挂起请求全部显式失败(服务端随后关连接)。
      // HelloRequest 无 ok 字段,用 in 收窄(同一 kind 两种方向)。
      if ("ok" in m && m.ok) {
        authed = true;
        flush();
      } else {
        failAll("鉴权失败: hello 被服务端拒绝");
      }
      return;
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
  ws.addEventListener("close", () => {
    open = false;
    failAll("连接已断开");
    opts.onDisconnect?.();
  });

  return {
    invoke(channel, ...args) {
      const id = ++seq;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        send(serializeWire({ kind: "invoke", id, channel, args }));
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
