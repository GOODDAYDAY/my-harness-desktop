// 远程访问控制面(web-service §18.6)——remote:* handler。经 RemoteAuth 的 config 读写。
// 公网隧道已移除(先只做本机/局域网);QR 是 client/remote 的职责。
// status 返回脱敏视图:密码 hash 不出服务端边界(敏感字段过滤在协议翻译层)。
// 密码策略(§8.1 修订):强密码(数字+字母+特殊符号),开启 LAN 必有密码——无密码不允许访问。
import { IPC } from "@my-harness-desktop/shared";
import type { Gateway } from "../routing/gateway";
import type { RemoteAuth } from "../remote/auth";
import type { RemoteConfig } from "../remote/remote-config";
import { generateStrongPassword, hashPassword, validatePasswordStrength } from "../remote/password";
import { getLanAddresses } from "../client/remote/lan-ip";
import { generateQr } from "../client/remote/qr";

/** 脱敏状态视图:hash 置 hasPassword 布尔,不落明文与 hash;lanUrls 供 UI 展示/二维码。
 *  actualPort 是真实监听口(配置文件里的 port 是设计默认值,未必等于实际绑定)。 */
export function redactRemoteConfig(cfg: RemoteConfig, actualPort: number): Record<string, unknown> {
  return {
    enabled: cfg.enabled,
    bind: cfg.bind,
    port: actualPort,
    lanUrls: getLanAddresses(),
    lan: {
      enabled: cfg.lan.enabled,
      hasPassword: cfg.lan.passwordHash !== null,
      customized: cfg.lan.customized,
    },
  };
}

export function registerRemote(gateway: Gateway, auth: RemoteAuth, opts: { port: number; rebind?: () => void }): void {
  const cfg = auth.config;
  // 最近一次「可展示」的密码明文(第 20 项):开启/刷新/设置时记下,随 status 与
  // stateChanged 广播到所有客户端——任何一端开启,所有端都看得到,不再只有操作端可见。
  // 信任边界与响应同口径:只达已鉴权客户端(本机免密 + 局域网登录后)。落盘仍只存 hash。
  let lastFreshPassword: string | null = null;
  const redact = () => redactRemoteConfig(cfg.get(), opts.port);
  const status = (): Record<string, unknown> => ({ ...redact(), freshPassword: lastFreshPassword });
  // 配置变更后广播,多客户端(本机窗口/本机浏览器/远程)设置页同步刷新。
  const pushState = () => gateway.broadcast(IPC.remote.stateChanged, status());
  // 绑定变更即时生效(第 19 项):开关后热重绑监听地址,不等重启。延迟一拍执行——
  // 先让本次 invoke 应答冲刷出去,重绑会终止所有现存连接(含调用者)。
  const rebind = () => {
    setTimeout(() => { try { opts.rebind?.(); } catch (e) { console.error("[remote] 重绑定失败:", e); } }, 150);
  };

  // 启动防御 + 重启可展示(第 14/20 项):开启态且非固定密码(含历史「无密码」裸奔态)
  // → 重启即刷新一次并把明文留在内存供广播;固定密码只存 hash 无法回显,
  // 由 UI「已固定」徽章呈现,用户要明文可点「刷新密码」。
  const boot = cfg.get();
  if (boot.enabled && (boot.lan.passwordHash === null || !boot.lan.customized)) {
    lastFreshPassword = generateStrongPassword();
    void cfg.update({ lan: { ...boot.lan, passwordHash: hashPassword(lastFreshPassword), customized: false } });
  }

  gateway.register(IPC.remote.status, () => status());

  gateway.register(IPC.remote.start, async () => {
    // 开启局域网访问:enabled + bind=lan(0.0.0.0),落配置后热重绑即时生效(§8.6 演进/第 19 项)。
    // 第 14 项(用户修订):每次开启必刷新一次密码,且必随响应返回明文供 UI 展示——
    // 不做「固定密码沿用」例外:只存 hash 无法回显,藏密码 = 用户拿不到凭证。
    // 固定密码的价值在「启用期间 + 重启后持续有效」,下一次开启仍会被刷新替换。
    const newPassword = generateStrongPassword();
    lastFreshPassword = newPassword;
    await cfg.update({ enabled: true, bind: "lan", lan: { ...cfg.get().lan, passwordHash: hashPassword(newPassword), customized: false } });
    rebind();
    pushState();
    return { ...status(), newPassword };
  });
  gateway.register(IPC.remote.stop, async () => {
    await cfg.update({ enabled: false, bind: "loopback" });
    rebind();
    pushState();
    return status();
  });

  gateway.register(IPC.remote.setPassword, async (_conn, password: string) => {
    const pwd = String(password ?? "");
    const weak = validatePasswordStrength(pwd);
    if (weak) throw new Error(weak);
    lastFreshPassword = pwd; // 用户刚敲的,可展示(第 20 项)
    await cfg.update({ lan: { ...cfg.get().lan, passwordHash: hashPassword(pwd), customized: true } });
    pushState();
    return status();
  });
  gateway.register(IPC.remote.refreshPassword, async () => {
    const pwd = generateStrongPassword();
    lastFreshPassword = pwd;
    await cfg.update({ lan: { ...cfg.get().lan, passwordHash: hashPassword(pwd), customized: false } });
    pushState();
    return pwd; // 返回明文供 UI 展示一次(§37.3)
  });
  gateway.register(IPC.remote.setLanPasswordEnabled, async (_conn, enabled: boolean) => {
    await cfg.update({ lan: { ...cfg.get().lan, enabled: Boolean(enabled) } });
    pushState();
    return status();
  });

  gateway.register(IPC.remote.qr, async () => {
    const ip = getLanAddresses()[0];
    if (!ip) return null;
    // 二维码只编码地址,不编码密码/凭证(§8.1:凭证不进 URL),设备扫码后走登录门。
    return generateQr(`http://${ip}:${opts.port}/`);
  });
}
