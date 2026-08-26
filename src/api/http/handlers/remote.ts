// 远程访问控制面(web-service §18.6)——remote:* handler。经 RemoteAuth 的 config 读写。
// 隧道/QR 是 client/remote 的职责(阶段 3 后续),此处先落状态/开关/密码的配置 CRUD。
import { randomInt } from "node:crypto";
import { IPC } from "../../../core/domain/channel-contract";
import type { Gateway } from "../../../core/application/remote/gateway";
import type { RemoteAuth } from "../../../core/application/remote/auth";
import { hashPassword } from "../../../core/application/remote/password";
import { getLanAddresses } from "../../../client/remote/lan-ip";
import { generateQr } from "../../../client/remote/qr";

/** 生成 8 位数字密码(§8.1)。 */
function randomPassword(): string {
  let s = "";
  for (let i = 0; i < 8; i++) s += String(randomInt(0, 10));
  return s;
}

export function registerRemote(gateway: Gateway, auth: RemoteAuth, opts: { port: number }): void {
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

  // tunnelStart/tunnelStop(cloudflared)阶段 3 后续;stateChanged push 由隧道状态驱动。
}
