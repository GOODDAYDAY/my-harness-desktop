// 远程访问控制面(web-service §18.6)——remote:* handler。经 RemoteAuth 的 config 读写。
// 隧道/QR 是 client/remote 的职责(阶段 3 后续),此处先落状态/开关/密码的配置 CRUD。
import { randomInt } from "node:crypto";
import { IPC } from "@my-harness-desktop/shared";
import type { Gateway } from "../routing/gateway";
import type { RemoteAuth } from "../remote/auth";
import { hashPassword } from "../remote/password";
import { getLanAddresses } from "../client/remote/lan-ip";
import { generateQr } from "../client/remote/qr";
import { startTunnel, type TunnelHandle } from "../client/remote/cloudflared";
import { ensureCloudflared } from "../client/remote/cloudflared-download";

/** 生成 8 位数字密码(§8.1)。 */
function randomPassword(): string {
  let s = "";
  for (let i = 0; i < 8; i++) s += String(randomInt(0, 10));
  return s;
}

export function registerRemote(gateway: Gateway, auth: RemoteAuth, opts: { port: number; cloudflaredDir: string }): void {
  const cfg = auth.config;

  gateway.register(IPC.remote.status, () => cfg.get());

  gateway.register(IPC.remote.start, async () => {
    // 开启局域网访问:enabled + bind=lan(0.0.0.0)。实际重绑定需重启生效(§8.6),这里先落配置。
    return cfg.update({ enabled: true, bind: "lan" });
  });
  gateway.register(IPC.remote.stop, async () => {
    return cfg.update({ enabled: false, bind: "loopback" });
  });

  gateway.register(IPC.remote.setPassword, async (_conn, password: string) => {
    const pwd = String(password ?? "");
    if (!/^\d{8}$/.test(pwd)) throw new Error("密码须为 8 位数字");
    return cfg.update({ lan: { ...cfg.get().lan, passwordHash: hashPassword(pwd), customized: true } });
  });
  gateway.register(IPC.remote.refreshPassword, async () => {
    const pwd = randomPassword();
    await cfg.update({ lan: { ...cfg.get().lan, passwordHash: hashPassword(pwd), customized: false } });
    return pwd; // 返回明文供 UI 展示一次(§37.3)
  });
  gateway.register(IPC.remote.setLanPasswordEnabled, async (_conn, enabled: boolean) => {
    return cfg.update({ lan: { ...cfg.get().lan, enabled: Boolean(enabled) } });
  });

  gateway.register(IPC.remote.qr, async () => {
    const ip = getLanAddresses()[0];
    if (!ip) return null;
    return generateQr(`http://${ip}:${opts.port}/`);
  });

  // 公网隧道(§39):cloudflared spawn + 解析 URL + stateChanged 广播。binary 缺省 "cloudflared"(PATH)。
  let tunnel: TunnelHandle | null = null;
  const pushTunnel = (state: Record<string, unknown>) => gateway.broadcast(IPC.remote.stateChanged, state);
  gateway.register(IPC.remote.tunnelStart, async (_conn, tOpts?: { binary?: string; disclaimer?: boolean }) => {
    if (!tOpts?.disclaimer) throw new Error("须先勾选公网免责声明"); // §39.4 服务端强校验
    if (tunnel) throw new Error("隧道已在运行");
    const binary = tOpts.binary ?? (await ensureCloudflared(opts.cloudflaredDir));
    return new Promise((resolve, reject) => {
      tunnel = startTunnel(binary, opts.port, (url) => {
        pushTunnel({ tunnel: { status: "running", url } });
        resolve({ ok: true, url });
      }, (code) => {
        tunnel = null;
        pushTunnel({ tunnel: { status: "stopped", code } });
      });
      // 超时兜底:15s 未解析 URL 视为失败
      setTimeout(() => {
        if (tunnel && !tunnel.url) { tunnel.stop(); tunnel = null; reject(new Error("隧道启动超时")); }
      }, 15000);
    });
  });
  gateway.register(IPC.remote.tunnelStop, async () => {
    tunnel?.stop();
    tunnel = null;
    return { ok: true };
  });
}
