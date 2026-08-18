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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import semver from "semver";
import type { KernelStatusView } from "../../domain/context";
import type { KernelRuntime } from "./kernel-runtime";

/** 一个内核的 npm 安装形态(包名 + 从 installDir 到 package.json 的相对路径段)。
 *  多内核(pi/dsh)共用同一套版本管理机制,差异只在包名与安装目录(§6.3)。 */
export interface KernelSpec {
  pkg: string;
  pkgJsonPath: string[];
}

/** pi 内核 npm 包。 */
export const PI_SPEC: KernelSpec = {
  pkg: "@earendil-works/pi-coding-agent",
  pkgJsonPath: ["node_modules", "@earendil-works", "pi-coding-agent", "package.json"],
};

/** dsh 内核 npm 包(DeepSeek harness CLI)。 */
export const DSH_SPEC: KernelSpec = {
  pkg: "@deepseek-ai/dsh",
  pkgJsonPath: ["node_modules", "@deepseek-ai", "dsh", "package.json"],
};

/** registry 查询结果。 */
export interface RegistryVersions {
  versions: string[];
  latest: string | null;
}

/** kernel 状态(供设置页展示)。契约单源在 domain/context(PluginContext 发布面经 contract
 *  到插件);此处 re-export 别名,main 侧消费者(kernel IPC/bootstrap)沿用旧名。 */
export type KernelStatus = KernelStatusView;

/** registry 缓存(per-pkg,10min TTL,避免设置页高频查重复打网络)。 */
const registryCache = new Map<string, { value: RegistryVersions; at: number }>();
const REGISTRY_TTL_MS = 10 * 60 * 1000;

/** 运行时(spawn/fetch/env 的外层实现),由 shell 经 initKernelRuntime 注入(依赖倒置)。 */
let runtime: KernelRuntime | null = null;

/** shell 启动期注入 KernelRuntime 实现(spawn/fetch/env 推到 shell,application 不直接做)。 */
export function initKernelRuntime(rt: KernelRuntime): void {
  runtime = rt;
}

function requireRuntime(): KernelRuntime {
  if (!runtime) throw new Error("kernel-manager 未注入 KernelRuntime(应经 initKernelRuntime 注入)");
  return runtime;
}

/** 数据根安装状态(kernelStatus 的零件;不含生效来源维度——那是 kernelStatus 的职责)。 */
export type InstalledVersionStatus = Pick<KernelStatus, "currentVersion" | "available" | "error">;

/**
 * 读某内核 installDir 下已安装的版本(唯一维护的来源,用户决策:只维护这一份)。
 * 直接读 package.json 的 version 字段,不 spawn CLI——避免依赖 PATH 里的那份。
 * 未安装返回 { available: false }。spec 缺省 pi(向后兼容)。
 */
export function currentVersion(installDir: string, spec: KernelSpec = PI_SPEC): InstalledVersionStatus {
  const pkgPath = join(installDir, ...spec.pkgJsonPath);
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

/** 自定义底座归一化结果。 */
export interface CustomCliResolution {
  /** cli.js 绝对路径(spawn 用) */
  cliJs: string;
  /** 包 package.json 的 version(读不到为 null,不因此判无效) */
  version: string | null;
}

/**
 * 自定义底座目录归一化(docs/design/custom-cli-path.md §2.3)——两种形态都认:
 * 形态一 包源码根:dir/dist/cli.js(自己 build 的仓库,优先——同时命中时开发意图优先);
 * 形态二 npm 安装目录:dir/node_modules/@earendil-works/pi-coding-agent/dist/cli.js。
 * 纯函数:只做存在性检查 + JSON 读取,不 spawn、不读环境(形态判断单源:
 * 写入校验/spawn 解析/状态展示三方共用)。都不命中返回 null。
 */
export function resolveCustomCli(dir: string): CustomCliResolution | null {
  const srcCliJs = join(dir, "dist", "cli.js");
  if (existsSync(srcCliJs)) {
    return { cliJs: srcCliJs, version: readPkgVersion(join(dir, "package.json")) };
  }
  const pkgRoot = join(dir, "node_modules", "@earendil-works", "pi-coding-agent");
  const npmCliJs = join(pkgRoot, "dist", "cli.js");
  if (existsSync(npmCliJs)) {
    return { cliJs: npmCliJs, version: readPkgVersion(join(pkgRoot, "package.json")) };
  }
  return null;
}

/** 读 package.json 的 version 字段;文件缺失/解析失败/无字段返回 null(宽松,不判无效)。 */
function readPkgVersion(pkgPath: string): string | null {
  try {
    if (!existsSync(pkgPath)) return null;
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: string };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

/**
 * kernel 状态合成(docs/design/custom-cli-path.md §2.6):
 * customCliDir 为空 → 数据根状态(source: installed);
 * 非空且归一化命中 → source: custom,currentVersion 取自定义版本,installedVersion 照常给数据根;
 * 非空但未命中(写后目录被删/移动) → source: custom 保留配置意图,状态跟随数据根,
 * error 标注已回落(spawn 侧同函数判定,同样回落,状态与行为一致)。
 */
export function kernelStatus(installDir: string, customCliDir: string): KernelStatus {
  const installed = currentVersion(installDir);
  if (!customCliDir) {
    return { ...installed, installedVersion: installed.currentVersion, source: "installed", customCliDir: "" };
  }
  const custom = resolveCustomCli(customCliDir);
  if (!custom) {
    return {
      ...installed,
      installedVersion: installed.currentVersion,
      source: "custom",
      customCliDir,
      error: "自定义底座目录无效（未找到 cli.js），已回落数据根安装",
    };
  }
  return {
    currentVersion: custom.version,
    installedVersion: installed.currentVersion,
    available: true,
    source: "custom",
    customCliDir,
    error: null,
  };
}

/**
 * 自定义 dsh 目录归一化(与 resolveCustomCli 同构,dsh 的 CLI 入口是 lib/bin.js):
 * 形态一 源码根:dir/apps/cli/lib/bin.js(deepseek-harness 仓库 build 后);
 * 形态二 npm 安装目录:dir/node_modules/@deepseek-ai/dsh/lib/bin.js。
 */
export function resolveDshCustomCli(dir: string): CustomCliResolution | null {
  const srcCliJs = join(dir, "apps", "cli", "lib", "bin.js");
  if (existsSync(srcCliJs)) {
    return { cliJs: srcCliJs, version: readPkgVersion(join(dir, "apps", "cli", "package.json")) };
  }
  const pkgRoot = join(dir, "node_modules", "@deepseek-ai", "dsh");
  const npmCliJs = join(pkgRoot, "lib", "bin.js");
  if (existsSync(npmCliJs)) {
    return { cliJs: npmCliJs, version: readPkgVersion(join(pkgRoot, "package.json")) };
  }
  return null;
}

/**
 * dsh kernel 状态合成(与 kernelStatus 同构,区别只在 spec=DSH_SPEC + resolveDshCustomCli)。
 * customCliDir 为空 → 数据根;非空且命中 → custom;非空未命中 → error 标注回落。
 */
export function dshKernelStatus(installDir: string, customCliDir: string): KernelStatus {
  const installed = currentVersion(installDir, DSH_SPEC);
  if (!customCliDir) {
    return { ...installed, installedVersion: installed.currentVersion, source: "installed", customCliDir: "" };
  }
  const custom = resolveDshCustomCli(customCliDir);
  if (!custom) {
    return {
      ...installed,
      installedVersion: installed.currentVersion,
      source: "custom",
      customCliDir,
      error: "自定义 dsh 目录无效（未找到 apps/cli/lib/bin.js），已回落数据根安装",
    };
  }
  return {
    currentVersion: custom.version,
    installedVersion: installed.currentVersion,
    available: true,
    source: "custom",
    customCliDir,
    error: null,
  };
}

/**
 * fetch npm registry 拿版本清单 + latest。⚠ 临时方案(盲审 H1/H2):
 * 仅用于**展示最新版本号**,不替用户决策"该不该更新"。底座补 `pi update --check`
 * 后改为 spawn 它解析 JSON、删掉本函数。
 * 网络失败时 fetchRegistryVersions 抛异常(不吞错),listRegistryVersions 透传 reject,
 * renderer catch 后显示"加载失败"。异常不缓存 → 下次打开重新 fetch。
 * fetch 经注入的 KernelRuntime(外层细节),application 不直接 fetch(依赖倒置)。
 */
export async function listRegistryVersions(forceRefresh = false, spec: KernelSpec = PI_SPEC): Promise<RegistryVersions> {
  const cached = registryCache.get(spec.pkg);
  if (!forceRefresh && cached && Date.now() - cached.at < REGISTRY_TTL_MS) {
    return cached.value;
  }
  const value = await requireRuntime().fetchRegistryVersions(spec.pkg);
  registryCache.set(spec.pkg, { value, at: Date.now() });
  return value;
}

/** 清 registry 缓存(更新后调,确保下次查到新 latest)。 */
export function invalidateRegistryCache(): void {
  registryCache.clear();
}


/** 写最小 staging package.json 到目标目录(供 npm install 落地)。 */
function writeStagingPackageJson(installDir: string): void {
  const pkg = JSON.stringify(
    { name: "my-harness-desktop-pi-stage", private: true, version: "1.0.0" },
    null,
    2,
  );
  mkdirSync(installDir, { recursive: true });
  writeFileSync(join(installDir, "package.json"), pkg, "utf-8");
}

/**
 * 下载安装某内核到独立目录(⚠ 偏离文档路线:文档反对桌面端 npm install,
 * 用户明确要,标注偏离)。spawn npm install 经注入的 KernelRuntime(外层细节),
 * application 不直接 spawn(依赖倒置)。version 白名单 + staging 文件写在本层(纯逻辑)。
 * spec 缺省 pi(向后兼容)。
 */
export async function installKernel(
  version: string,
  installDir: string,
  onProgress: (line: string) => void,
  spec: KernelSpec = PI_SPEC,
): Promise<{ ok: boolean; error: string | null }> {
  // version 白名单:只允许合法 semver(防 npm spec 注入)
  if (!semver.valid(version)) {
    return { ok: false, error: `非法版本号: ${version}` };
  }
  try {
    writeStagingPackageJson(installDir);
  } catch (err) {
    return { ok: false, error: `准备安装目录失败: ${(err as Error).message}` };
  }
  // spawn + 行缓冲转发在 shell 的 KernelRuntime 实现(进程管理是外层细节)
  return requireRuntime().installNpm(`${spec.pkg}@${version}`, installDir, onProgress);
}

/** 安装 pi(installKernel 的 pi 别名,向后兼容既有 IPC 调用点)。 */
export async function installPi(
  version: string,
  installDir: string,
  onProgress: (line: string) => void,
): Promise<{ ok: boolean; error: string | null }> {
  return installKernel(version, installDir, onProgress, PI_SPEC);
}

/** 安装 dsh Cordis 插件:直接 npm install 进 dsh 内核目录(复用其 package.json + node_modules),
 *  不写 staging package.json(那是内核全新安装用的,会覆盖已装内核的依赖清单)。
 *  包名白名单只放 @deepseek-ai/dsh-* 前缀,防 npm spec 注入;cordis.yml 写项由外层 DshConfigSource 完成。 */
export async function installDshPlugin(
  pkgName: string,
  installDir: string,
  onProgress: (line: string) => void,
): Promise<{ ok: boolean; error: string | null }> {
  if (!/^@deepseek-ai\/dsh-[a-z0-9-]+$/.test(pkgName)) {
    return { ok: false, error: `非法插件包名: ${pkgName}` };
  }
  return requireRuntime().installNpm(pkgName, installDir, onProgress);
}
