// 系统通知(web-service-architecture.md §20.5 HostNotify)——纯机制,文案由调用方传。
// 经 conn.host.notify;remote 连接 host 为缺省降级(no-op/不支持),不静默伪造。
import { IPC } from "../../../core/domain/channel-contract";
import type { Gateway } from "../../../core/application/remote/gateway";

export function registerNotification(gateway: Gateway): void {
  gateway.register(IPC.notification.show, (conn, payload: { title: string; body: string; silent?: boolean }) =>
    conn.host.notify.show(payload),
  );
}
