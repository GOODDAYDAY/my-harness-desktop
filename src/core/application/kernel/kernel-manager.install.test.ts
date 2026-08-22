// KernelManager.install / DshKernelManager.installPlugin 回归测试:附带包必须与主包同版本
// (根因:不带 @version 会落到 npm latest dist-tag,而 @deepseek-ai/dsh-* 的 latest 是陈旧的
// 0.0.1-rc.x,与新主包 0.1.0-rc.x 的 peer deps 冲突 → ERESOLVE);安装成功判定须回读已装版本,
// 不能只信 npm exit code(「假安装成功」)。用 DshKernelManager(具体实现)驱动基类逻辑。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initKernelRuntime } from "./kernel-manager";
import { DshKernelManager, DSH_SPEC } from "../../../client/dsh/dsh-kernel";
import type { KernelRuntime } from "./kernel-runtime";

let dir: string;
let manager: DshKernelManager;
const calls: string[] = [];
let installOk = true;
/** 模拟真实 npm install:installNpm 收到主包时落地到 installDir(供 currentVersion 回读)。 */
let landMainOnInstall = false;

function mockRuntime(): KernelRuntime {
  return {
    async installNpm(pkgSpec, installDir, _onProgress) {
      calls.push(pkgSpec);
      if (landMainOnInstall) {
        const m = /^@deepseek-ai\/dsh-sdk-jsonrpc-demo@(.+)$/.exec(pkgSpec);
        if (m) {
          const pkgRoot = join(installDir, "node_modules", "@deepseek-ai", "dsh-sdk-jsonrpc-demo");
          mkdirSync(pkgRoot, { recursive: true });
          writeFileSync(join(pkgRoot, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh-sdk-jsonrpc-demo", version: m[1] }));
        }
      }
      return { ok: installOk, error: installOk ? null : `npm install 退出码 1 (${pkgSpec})` };
    },
    async uninstallNpm(pkgSpec, _installDir, _onProgress) {
      calls.push(`uninstall:${pkgSpec}`);
      return { ok: installOk, error: installOk ? null : `npm uninstall 退出码 1 (${pkgSpec})` };
    },
    async fetchRegistryVersions() {
      return { versions: [], latest: null };
    },
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kernel-install-"));
  manager = new DshKernelManager(DSH_SPEC, dir);
  calls.length = 0;
  installOk = true;
  landMainOnInstall = false;
  initKernelRuntime(mockRuntime());
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 落地一份已装主包到 installDir,让 currentVersion 读到(用于回读校验)。 */
function landMainPackage(version: string): void {
  const pkgRoot = join(dir, "node_modules", "@deepseek-ai", "dsh-sdk-jsonrpc-demo");
  mkdirSync(pkgRoot, { recursive: true });
  writeFileSync(join(pkgRoot, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh-sdk-jsonrpc-demo", version }));
}

describe("install 附带包版本钉死", () => {
  it("附带包与主包同版本:每次 installNpm 都带 @version", async () => {
    const r = await manager.install("0.1.0-rc.7", () => {});
    // 主包 + 9 个附带包,全部 @0.1.0-rc.7。
    expect(calls).toHaveLength(1 + (DSH_SPEC.extraPackages?.length ?? 0));
    expect(calls[0]).toBe(`${DSH_SPEC.pkg}@0.1.0-rc.7`);
    for (const pkg of DSH_SPEC.extraPackages ?? []) {
      expect(calls).toContain(`${pkg}@0.1.0-rc.7`);
    }
    // 无任何裸包名(不带 @version)——那就是旧的 latest 落点 bug。
    for (const c of calls) expect(c).toContain("@");
    expect(r.ok).toBe(false); // 回读校验:fixture 没落地主包 package.json
  });

  it("全部装成且主包落地 → ok:true", async () => {
    // 覆盖式安装会先清旧 node_modules,所以主包须由 installNpm 落地(模拟真实 npm)。
    landMainOnInstall = true;
    const r = await manager.install("0.1.0-rc.7", () => {});
    expect(r.ok).toBe(true);
    expect(r.error).toBeNull();
  });

  it("npm exit 0 但主包未落地 → 回读校验判失败(堵「假安装成功」)", async () => {
    // installOk=true(模拟 npm exit 0),但 fixture 不落地主包 → ok 必须为 false。
    const r = await manager.install("0.1.0-rc.7", () => {});
    expect(r.ok).toBe(false);
    expect(r.error).toContain("校验失败");
  });

  it("非法版本号 → 直接拒绝,不 spawn", async () => {
    const r = await manager.install("../etc/passwd", () => {});
    expect(r.ok).toBe(false);
    expect(r.error).toContain("非法版本号");
    expect(calls).toHaveLength(0);
  });
});

describe("install 覆盖式清旧(堵升级 ERESOLVE)", () => {
  it("升级前清掉旧 node_modules + package-lock(不留旧树给 npm 增量更新)", async () => {
    // 现场:已装 0.1.0-rc.7(旧主包落地)+ 旧 lock 文件,再升级到 0.1.1-rc.2。
    landMainPackage("0.1.0-rc.7");
    writeFileSync(join(dir, "package-lock.json"), '{"lockfileVersion":3}');
    const stalePkg = join(dir, "node_modules", "@deepseek-ai", "dsh-invariants");
    mkdirSync(stalePkg, { recursive: true });
    writeFileSync(join(stalePkg, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh-invariants", version: "0.1.0-rc.7" }));

    const r = await manager.install("0.1.1-rc.2", () => {});

    // 旧 node_modules 与 lock 已被清掉(否则 npm 增量更新会 ERESOLVE)。
    expect(existsSync(join(dir, "package-lock.json"))).toBe(false);
    expect(existsSync(join(dir, "node_modules", "@deepseek-ai", "dsh-sdk-jsonrpc-demo"))).toBe(false);
    expect(existsSync(join(dir, "node_modules", "@deepseek-ai", "dsh-invariants"))).toBe(false);
    // mock runtime 不落地新主包 → 回读校验判失败(清理已在安装前发生)。
    expect(r.ok).toBe(false);
    expect(r.error).toContain("校验失败");
  });
});

describe("installPlugin 钉到已装内核版本", () => {
  it("内核未装 → 拒绝,不 spawn", async () => {
    const r = await manager.installPlugin("@deepseek-ai/dsh-tool-todo", () => {});
    expect(r.ok).toBe(false);
    expect(r.error).toContain("未安装");
    expect(calls).toHaveLength(0);
  });

  it("内核已装 → 插件带已装版本,不带裸名", async () => {
    landMainPackage("0.1.0-rc.7");
    const r = await manager.installPlugin("@deepseek-ai/dsh-tool-todo", () => {});
    expect(calls).toEqual(["@deepseek-ai/dsh-tool-todo@0.1.0-rc.7"]);
    expect(r.ok).toBe(true);
  });

  it("非法插件包名(白名单外)→ 拒绝", async () => {
    landMainPackage("0.1.0-rc.7");
    const r = await manager.installPlugin("evil-pkg", () => {});
    expect(r.ok).toBe(false);
    expect(r.error).toContain("非法插件包名");
    expect(calls).toHaveLength(0);
  });
});
