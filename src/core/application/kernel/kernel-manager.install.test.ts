// installKernel / installDshPlugin 回归测试:附带包必须与主包同版本(根因:不带 @version
// 会落到 npm latest dist-tag,而 @deepseek-ai/dsh-* 的 latest 是陈旧的 0.0.1-rc.x,与新
// 主包 0.1.0-rc.x 的 peer deps 冲突 → ERESOLVE);安装成功判定须回读已装版本,不能只信
// npm exit code(「假安装成功」)。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installKernel,
  installDshPlugin,
  initKernelRuntime,
  DSH_SPEC,
  type KernelSpec,
} from "./kernel-manager";
import type { KernelRuntime } from "./kernel-runtime";

let dir: string;
const calls: string[] = [];
let installOk = true;

function mockRuntime(): KernelRuntime {
  return {
    async installNpm(pkgSpec, _installDir, _onProgress) {
      calls.push(pkgSpec);
      return { ok: installOk, error: installOk ? null : `npm install 退出码 1 (${pkgSpec})` };
    },
    async fetchRegistryVersions() {
      return { versions: [], latest: null };
    },
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kernel-install-"));
  calls.length = 0;
  installOk = true;
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

describe("installKernel 附带包版本钉死", () => {
  it("附带包与主包同版本:每次 installNpm 都带 @version", async () => {
    const r = await installKernel("0.1.0-rc.7", dir, () => {}, DSH_SPEC);
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
    landMainPackage("0.1.0-rc.7");
    const r = await installKernel("0.1.0-rc.7", dir, () => {}, DSH_SPEC);
    expect(r.ok).toBe(true);
    expect(r.error).toBeNull();
  });

  it("npm exit 0 但主包未落地 → 回读校验判失败(堵「假安装成功」)", async () => {
    // installOk=true(模拟 npm exit 0),但 fixture 不落地主包 → ok 必须为 false。
    const r = await installKernel("0.1.0-rc.7", dir, () => {}, DSH_SPEC);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("校验失败");
  });

  it("非法版本号 → 直接拒绝,不 spawn", async () => {
    const r = await installKernel("../etc/passwd", dir, () => {}, DSH_SPEC);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("非法版本号");
    expect(calls).toHaveLength(0);
  });
});

describe("installDshPlugin 钉到已装内核版本", () => {
  it("内核未装 → 拒绝,不 spawn", async () => {
    const r = await installDshPlugin("@deepseek-ai/dsh-tool-todo", dir, () => {});
    expect(r.ok).toBe(false);
    expect(r.error).toContain("未安装");
    expect(calls).toHaveLength(0);
  });

  it("内核已装 → 插件带已装版本,不带裸名", async () => {
    landMainPackage("0.1.0-rc.7");
    const r = await installDshPlugin("@deepseek-ai/dsh-tool-todo", dir, () => {});
    expect(calls).toEqual(["@deepseek-ai/dsh-tool-todo@0.1.0-rc.7"]);
    expect(r.ok).toBe(true);
  });

  it("非法插件包名(白名单外)→ 拒绝", async () => {
    landMainPackage("0.1.0-rc.7");
    const r = await installDshPlugin("evil-pkg", dir, () => {});
    expect(r.ok).toBe(false);
    expect(r.error).toContain("非法插件包名");
    expect(calls).toHaveLength(0);
  });
});
