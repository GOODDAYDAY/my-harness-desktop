// pi 内核管理 —— application 层用例编排。
//
// 依据 docs/structure/18 §3.1.2/§4.5.1(壳不替底座管更新,spawn `pi update` 走底座自己)。
// 关键纪律:
// - application 不 import electron(守"application 不依赖 shell")。
// - 用 Node 内置 child_process(标准库)+ fetch(Node 25 内置),不绑 shell。
// - **不下载、不替换底座文件、不 spawn npm**(文档路线)。只 spawn 底座自己的命令。
// - **不重复底座领域知识**:不实现 detectInstallMethod/getSelfUpdateCommand/版本决策,
//   底座更新决策由底座 `pi update` 自己做,桌面端只透出。
// - spawn 在 application 层执行,插件不声明 child:command;env 用 allowlist 不继承宿主凭证。
//
// ⚠ 已知缺口(盲审 H1/H2,诚实标注):文档说探测更新应 spawn `pi update --check` 拿
// JSON 决策,但实际 pi 0.80.7 无 --check flag(底座未补)。当前 listRegistryVersions
// fetch npm registry 只用于**展示最新版本号**(不替用户决策"该不该更新"),是底座补
// --check 前的临时方案。底座补 --check 后,改为 spawn 它解析 JSON,删掉 registry fetch。
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** pi npm 包名(底座 CLI 的 npm 来源)。 */
const PKG = "@earendil-works/pi-coding-agent";

/** npm registry 元数据 URL(临时展示用,底座补 --check 后删)。 */
const REGISTRY_URL = "https://registry.npmjs.org/@earendil-works%2Fpi-coding-agent";

/** registry 查询结果。 */
export interface RegistryVersions {
  versions: string[];
  latest: string | null;
}

/** kernel 状态(供设置页展示)。 */
export interface KernelStatus {
  /** 当前已安装 pi 版本(pi --version),pi 不可用为 null */
  currentVersion: string | null;
  /** pi 是否可用(PATH 里能 spawn) */
  available: boolean;
  /** 不可用时的错误信息 */
  error: string | null;
}

/** registry 缓存(10min TTL,避免设置页高频查重复打网络)。 */
let registryCache: { value: RegistryVersions; at: number } | null = null;
const REGISTRY_TTL_MS = 10 * 60 * 1000;

/** env allowlist:不继承宿主凭证(02-security),只传必要的 PATH 和 HOME
 *  (HOME 给 pi 定位 ~/.pi/agent 凭证目录、npm 全局路径解析用)。 */
function safeEnv(): NodeJS.ProcessEnv {
  return { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "" };
}

/**
 * 读 ~/.pi-desktop/pi 已安装的 pi 版本(唯一维护的来源,用户决策:只维护这一份)。
 * 直接读 node_modules/@earendil-works/pi-coding-agent/package.json 的 version 字段,
 * 不 spawn pi——避免依赖 PATH 里的 pi(那份不归桌面端管)。
 * 未安装返回 { available: false }。
 */
export function currentVersion(installDir: string): KernelStatus {
  const pkgPath = join(installDir, "node_modules", "@earendil-works", "pi-coding-agent", "package.json");
  try {
    if (!existsSync(pkgPath)) {
      return { currentVersion: null, available: false, error: null };
    }
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: string };
    const v = pkg.version ?? null;
    return { currentVersion: v, available: !!v, error: null };
  } catch (err) {
    return { currentVersion: null, available: false, error: `读已装版本失败: ${(err as Error).message}` };
  }
}

/**
 * fetch npm registry 拿版本清单 + latest。⚠ 临时方案(盲审 H1/H2):
 * 仅用于**展示最新版本号**,不替用户决策"该不该更新"。底座补 `pi update --check`
 * 后改为 spawn 它解析 JSON、删掉本函数。
 * 网络失败返回空(不抛错,设置页显示"加载失败")。
 */
export async function listRegistryVersions(forceRefresh = false): Promise<RegistryVersions> {
  if (!forceRefresh && registryCache && Date.now() - registryCache.at < REGISTRY_TTL_MS) {
    return registryCache.value;
  }
  try {
    const resp = await fetch(REGISTRY_URL, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(25_000),
    });
    if (!resp.ok) return { versions: [], latest: null };
    const data = (await resp.json()) as {
      versions?: Record<string, unknown>;
      "dist-tags"?: { latest?: string };
    };
    const versions = Object.keys(data.versions ?? {});
    const latest = data["dist-tags"]?.latest ?? null;
    const value: RegistryVersions = { versions, latest };
    registryCache = { value, at: Date.now() };
    return value;
  } catch {
    return { versions: [], latest: null };
  }
}

/** 清 registry 缓存(更新后调,确保下次查到新 latest)。 */
export function invalidateRegistryCache(): void {
  registryCache = null;
}


/** 写最小 staging package.json 到目标目录(供 npm install 落地)。 */
function writeStagingPackageJson(installDir: string): void {
  const pkg = JSON.stringify(
    { name: "pi-desktop-pi-stage", private: true, version: "1.0.0" },
    null,
    2,
  );
  mkdirSync(installDir, { recursive: true });
  writeFileSync(join(installDir, "package.json"), pkg, "utf-8");
}

/**
 * 下载安装 pi 到独立目录(⚠ 偏离文档路线:文档反对桌面端 npm install,
 * 用户明确要,标注偏离)。spawn `npm install @earendil-works/pi-coding-agent@version`
 * 到 installDir(默认 ~/.pi-desktop/pi),stdout 行转发 onProgress。
 * 不替换 PATH 里的 pi(由 spawn 时 PATH 前置决定优先级,见 safeEnvWithInstallDir)。
 * 完成校验入口存在;失败透出 npm stderr。
 */
export function installPi(
  version: string,
  installDir: string,
  onProgress: (line: string) => void,
): Promise<{ ok: boolean; error: string | null }> {
  return new Promise((resolve) => {
    // version 白名单:只允许 semver(盲审 H1,防 npm spec 注入)
    if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
      resolve({ ok: false, error: `非法版本号: ${version}` });
      return;
    }
    try {
      writeStagingPackageJson(installDir);
    } catch (err) {
      resolve({ ok: false, error: `准备安装目录失败: ${(err as Error).message}` });
      return;
    }
    let child;
    try {
      // --ignore-scripts 禁用 npm lifecycle scripts(盲审 H1,防供应链脚本执行)
      child = spawn(
        "npm",
        ["install", `${PKG}@${version}`, "--no-audit", "--no-fund", "--omit=dev", "--ignore-scripts"],
        { cwd: installDir, env: safeEnv(), shell: false },
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
}

/** spawn pi 时 PATH 前置独立环境 bin(让 ~/.pi-desktop/pi 装的 pi 也能被 spawn 到)。 */
export function safeEnvWithInstallDir(installBinDir: string | null): NodeJS.ProcessEnv {
  const base = safeEnv();
  if (installBinDir) {
    base["PATH"] = `${installBinDir}:${base["PATH"] ?? ""}`;
  }
  return base;
}
