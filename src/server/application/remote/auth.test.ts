// 远程鉴权服务单测(web-service §8.2/§8.3/§37.2)。

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteAuth } from "./auth";
import { RemoteConfigStore } from "./remote-config";
import { hashPassword } from "./password";

let dirs: string[] = [];
function tmpConfig(): RemoteConfigStore {
  const d = mkdtempSync(join(tmpdir(), "remote-auth-"));
  dirs.push(d);
  return new RemoteConfigStore(join(d, "remote.json"));
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("RemoteAuth", () => {
  it("本地 token → local;HMAC token → remote", () => {
    const auth = new RemoteAuth(tmpConfig());
    const verify = auth.createTokenVerifier();
    expect(verify(auth.localToken)).toBe("local");
    const t = auth.signRemoteToken();
    expect(verify(t)).toBe("remote");
    expect(verify("garbage")).toBeNull();
  });

  it("checkPassword 命中局域网/公网任一套", async () => {
    const cfg = tmpConfig();
    await cfg.update({ lan: { ...cfg.get().lan, passwordHash: hashPassword("12345678"), enabled: true } });
    const auth = new RemoteAuth(cfg);
    expect(auth.checkPassword("12345678")).toBe(true);
    expect(auth.checkPassword("wrong")).toBe(false);
  });

  it("HMAC token 换 serverSecret 失效(重启全失效)", () => {
    const cfg = tmpConfig();
    const a1 = new RemoteAuth(cfg);
    const t = a1.signRemoteToken();
    const a2 = new RemoteAuth(cfg); // 新进程(新 serverSecret)
    expect(a2.createTokenVerifier()(t)).toBeNull();
  });
});
