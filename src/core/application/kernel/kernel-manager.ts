// 内核版本管理基类 —— application 层用例编排(机制,不含具体内核)。
//
// pi/dsh 共用同一套「装/查/状态合成」机制,差异只在 KernelSpec 数据 + 安装后钩子
// (postInstall)。基类只 import 圆心类型(kernel-manager.ts)+ KernelRuntime 接口,
// 不 import 任何具体内核——spec 值(PI_SPEC/DSH_SPEC)与子类(PiKernelManager/
// DshKernelManager)在 client/pi、client/dsh(实现层),组装在 bootstrap(§kernel-layer)。
//
// 关键纪律:
// - application 不 import electron/client(守"依赖只向内")。
// - spawn npm / fetch registry 经注入的 KernelRuntime(外层细节),本层只依赖接口。
// - ⚠ 已知缺口(盲审 H1/H2):listVersions fetch registry 只用于展示最新版本号,不替
//   用户决策"该不该更新",是内核补 `pi update --check` 前的临时方案。

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import semver from "semver";
import type { KernelStatusView } from "../../domain/context";
import type {
  KernelSpec, RegistryVersions, CustomCliResolution, InstalledVersionStatus,
} from "../../domain/kernel-manager";
import type { KernelRuntime } from "./kernel-runtime";

/** kernel 状态(供设置页展示)。契约单源在 domain/context,此处 re-export 别名。 */
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

/** 清 registry 缓存(更新后调,确保下次查到新 latest)。 */
export function invalidateRegistryCache(): void {
  registryCache.clear();
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

/** 准备安装目录(覆盖式安装:装新=更新、装旧=降级)——清掉上一版产物再写最小 staging
 *  package.json 供 npm install 落地。
 *
 *  ⚠ 根因(实证):不清 node_modules + package-lock.json 时,npm 对旧树做增量更新,dsh 主包
 *  的 peer deps(dsh-invariants/cordis)跨 0.1.0→0.1.1 升版后,新版要求 ^0.1.1-rc.x 而旧版
 *  遗留的 0.1.0-rc.x 无法满足 → ERESOLVE → 升级永远失败(见 kernel-manager.install.test)。
 *  清干净后等于全新安装,主包 + 附带包一次装成。 */
function prepareInstallDir(installDir: string): void {
  mkdirSync(installDir, { recursive: true });
  rmSync(join(installDir, "node_modules"), { recursive: true, force: true });
  rmSync(join(installDir, "package-lock.json"), { force: true });
  const pkg = JSON.stringify(
    { name: "my-harness-desktop-kernel-stage", private: true, version: "1.0.0" },
    null,
    2,
  );
  writeFileSync(join(installDir, "package.json"), pkg, "utf-8");
}

/**
 * 内核版本管理基类。一个具体内核 = 一份 KernelSpec + 一个可选的 postInstall 钩子。
 * 通用机制(装/查/状态合成)全在这里,spec 值由子类(client/pi、client/dsh)提供。
 */
export abstract class KernelManager {
  constructor(
    protected readonly spec: KernelSpec,
    protected readonly installDir: string,
  ) {}

  /** 读数据根已安装版本(直接读 package.json,不 spawn CLI——避免依赖 PATH 里的那份)。 */
  currentVersion(): InstalledVersionStatus {
    const pkgPath = join(this.installDir, ...this.spec.pkgJsonPath);
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
   * 自定义目录归一化(docs/design/custom-cli-path.md §2.3)——两种形态都认:
   * 形态一 源码根(开发仓库 build 后,优先——同时命中时开发意图优先);
   * 形态二 npm 安装目录(node_modules)。
   * 纯函数:只做存在性检查 + JSON 读取,不 spawn、不读环境。都不命中返回 null。
   */
  resolveCustomCli(dir: string): CustomCliResolution | null {
    const srcCliJs = join(dir, ...this.spec.srcCli);
    if (existsSync(srcCliJs)) {
      return { cliJs: srcCliJs, version: readPkgVersion(join(dir, ...this.spec.srcPkgJson)) };
    }
    const npmPkgRoot = join(dir, ...this.spec.pkgJsonPath.slice(0, -1));
    const npmCliJs = join(npmPkgRoot, ...this.spec.cliWithinPkg);
    if (existsSync(npmCliJs)) {
      return { cliJs: npmCliJs, version: readPkgVersion(join(npmPkgRoot, "package.json")) };
    }
    return null;
  }

  /**
   * 状态合成(docs/design/custom-cli-path.md §2.6):
   * customCliDir 空 → 数据根(source: installed);
   * 非空且命中 → source: custom,currentVersion 取自定义版本;
   * 非空未命中 → source: custom 保留配置意图,状态跟随数据根,error 标注回落。
   */
  status(customCliDir: string): KernelStatus {
    const installed = this.currentVersion();
    if (!customCliDir) {
      return { ...installed, installedVersion: installed.currentVersion, source: "installed", customCliDir: "" };
    }
    const custom = this.resolveCustomCli(customCliDir);
    if (!custom) {
      return {
        ...installed,
        installedVersion: installed.currentVersion,
        source: "custom",
        customCliDir,
        error: `自定义目录无效（未找到 ${this.spec.cliJsLabel}），已回落数据根安装`,
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

  /** fetch npm registry 拿版本清单 + 指定 dist-tag 的最新版本(临时方案,见文件头缺口标注)。 */
  async listVersions(forceRefresh = false): Promise<RegistryVersions> {
    const cached = registryCache.get(this.spec.pkg);
    if (!forceRefresh && cached && Date.now() - cached.at < REGISTRY_TTL_MS) {
      return cached.value;
    }
    const value = await requireRuntime().fetchRegistryVersions(this.spec.pkg, this.spec.distTag ?? "latest");
    registryCache.set(this.spec.pkg, { value, at: Date.now() });
    return value;
  }

  /**
   * 下载安装本内核到独立目录(⚠ 偏离文档路线:文档反对桌面端 npm install,用户明确要)。
   * version 白名单 + staging 文件写在本层(纯逻辑),spawn npm 经注入的 KernelRuntime。
   * 附带包必须与主包同版本(根因见下),装完回读校验 + 触发 postInstall 钩子。
   */
  async install(version: string, onProgress: (line: string) => void): Promise<{ ok: boolean; error: string | null }> {
    // version 白名单:只允许合法 semver(防 npm spec 注入)
    if (!semver.valid(version)) {
      return { ok: false, error: `非法版本号: ${version}` };
    }
    try {
      prepareInstallDir(this.installDir);
    } catch (err) {
      return { ok: false, error: `准备安装目录失败: ${(err as Error).message}` };
    }
    // 主包(带版本)+ 附带插件包(必须同版本)。dsh 的运行时是「bin + 插件」组合,
    // 插件由 cordis.yml 按包名解析,须与主包同一 rc 线。
    //
    // ⚠ 根因(实证):附带包之前不写 @version,npm 会落到该包 latest dist-tag,而
    // @deepseek-ai/dsh-* 的 latest 是陈旧的 0.0.1-rc.1/0.0.1-rc.5,真实新发版
    // 0.1.0-rc.7 挂在 next。于是主包新、附带包旧 → peer deps 冲突 → ERESOLVE →
    // 安装永远失败 → currentVersion 读不到 → 每次都要重装。同版本对齐后一次装成。
    const main = await this.installNpm(`${this.spec.pkg}@${version}`, onProgress);
    if (!main.ok) return main;
    for (const pkg of this.spec.extraPackages ?? []) {
      const r = await this.installNpm(`${pkg}@${version}`, onProgress);
      if (!r.ok) return { ok: false, error: `附带包 ${pkg} 安装失败: ${r.error}` };
    }
    this.postInstall(onProgress);
    // 成功判定不能只信 npm exit code(npm 可能 exit 0 却没把包落到预期路径,造成
    // 「假安装成功」——UI 报成功、status 仍显示未装)。回读一次已装版本,ok 与
    // currentVersion 口径一致。
    const verified = this.currentVersion();
    if (!verified.available) {
      return {
        ok: false,
        error: `安装后校验失败: ${this.spec.pkg} 未落到 ${this.installDir}(${verified.error ?? "package.json 缺失"})`,
      };
    }
    return { ok: true, error: null };
  }

  /** spawn npm install 一个包到 installDir(runtime 依赖倒置的封装,子类 installPlugin 复用)。 */
  protected async installNpm(pkgSpec: string, onProgress: (line: string) => void): Promise<{ ok: boolean; error: string | null }> {
    return requireRuntime().installNpm(pkgSpec, this.installDir, onProgress);
  }

  /** spawn npm uninstall 一个包(装/卸对称,子类 uninstallPlugin 复用)。 */
  protected async uninstallNpm(pkgSpec: string, onProgress: (line: string) => void): Promise<{ ok: boolean; error: string | null }> {
    return requireRuntime().uninstallNpm(pkgSpec, this.installDir, onProgress);
  }

  /** 安装后钩子(默认空)。子类覆盖:pi 打内核补丁,dsh 无。 */
  protected postInstall(_onProgress: (line: string) => void): void {}
}
