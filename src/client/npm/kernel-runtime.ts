// KernelRuntime 实现:spawn npm install + fetch registry + env allowlist(评估 P2 依赖倒置,
// 进程管理/网络/环境是外层细节,归 client;application 的 kernel-manager 经接口调用)。
import { spawn } from "node:child_process";
import type { KernelRuntime } from "../../core/application/kernel/kernel-runtime";

/** scoped 包名 → registry path 编码(@scope/pkg → @scope%2Fpkg)。 */
function registryUrl(pkgName: string): string {
  const encoded = pkgName.startsWith("@") ? pkgName.replace("/", "%2F") : pkgName;
  return `https://registry.npmjs.org/${encoded}`;
}

// env allowlist 跨平台:Windows 环境变量名大小写不敏感(实际可能是 Path 而非 PATH),
// 且无 HOME(是 USERPROFILE);SystemRoot/COMSPEC 是 win 起 shell 的必需,TEMP/TMP 是 npm 落临时文件的必需。
// 收窄意图不变(防 install 脚本环境泄露,--ignore-scripts 双保险),只保证 npm 跑起来所需的最小集。
const NPM_ENV_ALLOWLIST = new Set([
  "path", "pathext", "home", "userprofile", "homedrive", "homepath",
  "systemroot", "windir", "comspec", "appdata", "localappdata",
  "temp", "tmp", "tmpdir",
  "http_proxy", "https_proxy", "no_proxy",
]);

function npmSpawnEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    const lk = key.toLowerCase();
    if (NPM_ENV_ALLOWLIST.has(lk) || lk.startsWith("npm_config_")) env[key] = value;
  }
  return env;
}

/** spawn npm install/uninstall(装/卸对称);stdout/stderr 行转发 onProgress。 */
function spawnNpm(
  subcommand: "install" | "uninstall",
  pkgSpec: string,
  installDir: string,
  onProgress: (line: string) => void,
): Promise<{ ok: boolean; error: string | null }> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(
        "npm",
        [subcommand, pkgSpec, "--no-audit", "--no-fund", "--omit=dev", "--ignore-scripts"],
        // win32 的 npm 是 npm.cmd(批处理),CreateProcess 不能直接执行,必须经 shell(cmd.exe)解析。
        { cwd: installDir, env: npmSpawnEnv(), shell: process.platform === "win32" },
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
      resolve({ ok: code === 0, error: code === 0 ? null : `npm ${subcommand} 退出码 ${code}` });
    });
  });
}

export function createNpmKernelRuntime(): KernelRuntime {
  return {
    installNpm(pkgSpec, installDir, onProgress) {
      return spawnNpm("install", pkgSpec, installDir, onProgress);
    },
    uninstallNpm(pkgSpec, installDir, onProgress) {
      return spawnNpm("uninstall", pkgSpec, installDir, onProgress);
    },
    async fetchRegistryVersions(pkgName: string, distTag = "latest") {
      const resp = await fetch(registryUrl(pkgName), {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(25_000),
      });
      if (!resp.ok) throw new Error(`registry ${resp.status}`);
      const data = (await resp.json()) as {
        versions?: Record<string, unknown>; "dist-tags"?: Record<string, string>;
      };
      const semverMod = await import("semver");
      const versions = semverMod.default.sort(Object.keys(data.versions ?? {}).filter((v) => semverMod.default.valid(v)));
      return { versions, latest: data["dist-tags"]?.[distTag] ?? null };
    },
  };
}
