// KernelRuntime 实现:spawn npm install + fetch registry + env allowlist(评估 P2 依赖倒置,
// 进程管理/网络/环境是外层细节,归 client;application 的 kernel-manager 经接口调用)。
import { spawn } from "node:child_process";
import type { KernelRuntime } from "../../core/application/kernel/kernel-runtime";

const REGISTRY_URL = "https://registry.npmjs.org/@earendil-works%2Fpi-coding-agent";

export function createNpmKernelRuntime(): KernelRuntime {
  return {
    installNpm(pkgSpec, installDir, onProgress) {
      return new Promise((resolve) => {
        let child;
        try {
          child = spawn(
            "npm",
            ["install", pkgSpec, "--no-audit", "--no-fund", "--omit=dev", "--ignore-scripts"],
            { cwd: installDir, env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "" }, shell: false },
          );
        } catch (err) {
          resolve({ ok: false, error: `npm 启动失败: ${(err as Error).message}` });
          return;
        }
        const lineBuf: Buffer[] = [];
        child.on("error", (e) => resolve({ ok: false, error: `npm 启动失败: ${e.message}` }));
        child.stdout?.on("data", (d: Buffer) => {
          lineBuf.push(d);
          const text = Buffer.concat(lineBuf).toString();
          const lines = text.split("\n");
          lineBuf.length = 0;
          const rest = lines[lines.length - 1];
          if (rest) lineBuf.push(Buffer.from(rest));
          for (const line of lines.slice(0, -1)) onProgress(line);
        });
        child.stderr?.on("data", (d: Buffer) => onProgress(`[stderr] ${d.toString().trim()}`));
        child.on("close", (code) => {
          if (lineBuf.length > 0) {
            const rest = Buffer.concat(lineBuf).toString();
            if (rest.trim()) onProgress(rest.trim());
          }
          resolve({ ok: code === 0, error: code === 0 ? null : `npm install 退出码 ${code}` });
        });
      });
    },
    async fetchRegistryVersions() {
      const resp = await fetch(REGISTRY_URL, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(25_000),
      });
      if (!resp.ok) throw new Error(`registry ${resp.status}`);
      const data = (await resp.json()) as {
        versions?: Record<string, unknown>; "dist-tags"?: { latest?: string };
      };
      const semverMod = await import("semver");
      const versions = semverMod.default.sort(Object.keys(data.versions ?? {}).filter((v) => semverMod.default.valid(v)));
      return { versions, latest: data["dist-tags"]?.latest ?? null };
    },
  };
}
