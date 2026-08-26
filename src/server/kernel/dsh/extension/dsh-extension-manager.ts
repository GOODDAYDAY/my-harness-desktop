// client/dsh/dsh-extension-manager.ts —— dsh 内核拓展源(实现层)。
//
// extends KernelExtensionManager(基类):dsh 只填「数据从哪扫(cordis.yml + node_modules)
// + 开关怎么落盘(文本块移出/还原)+ 装/卸怎么执行(npm install/uninstall)」。
// 关键对齐(docs/core/extension-management.md §0.7):「可用/未配置」(node_modules 有包、
// cordis.yml 未声明)折叠进 enabled:false——和「禁用」是同一个功能态,不再有第三列表;
// enable(id) 统一语义「让它生效」:有禁用记录还原、没有就 addPlugin 新增 cordis 块。
//
// 依赖方向只向内:client import core/application(基类)+ core/domain(契约)+ 同层 config/kernel。

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { KernelExtensionManager } from "../../../application/extensions/kernel-extension-manager";
import type { KernelExtensionInfo, KernelExtensionCapabilities, KernelExtensionMutationResult } from "@my-harness-desktop/shared";
import type { DshConfigSource } from "../backend/dsh-config-source";
import type { DshKernelManager } from "../manager/dsh-kernel";
import type { DshExtensionManifest } from "./dsh-extension-manifest";

/** dsh 侧受保护名单(boot 关键插件,禁关/禁卸)。 */
const DSH_PROTECTED = ["sdk-jsonrpc-server", "agent-core", "sessions", "llm-deepseek", "llm-pi-ai"];

/** cordis 条目 name 是否是文件路径（桌面随附的相对路径插件），区别于 npm 包名（@scope/name）。 */
function isLocalEntry(name: string): boolean {
  return name.startsWith("./") || name.startsWith("../") || name.startsWith("/");
}

export interface DshExtensionManagerOptions {
  dshConfigSource: DshConfigSource;
  dshKernelManager: DshKernelManager;
  /** dsh 内核 npm 安装目录(node_modules 元信息读取用)。 */
  installDir?: string;
  onConfigChanged?: (reason: string) => void;
}

export class DshExtensionManager extends KernelExtensionManager {
  readonly capabilities: KernelExtensionCapabilities = { update: false, reorder: false };

  private readonly dshConfigSource: DshConfigSource;
  private readonly dshKernelManager: DshKernelManager;
  private readonly installDir?: string;

  constructor(opts: DshExtensionManagerOptions) {
    super({ protectedIds: new Set(DSH_PROTECTED), onConfigChanged: opts.onConfigChanged });
    this.dshConfigSource = opts.dshConfigSource;
    this.dshKernelManager = opts.dshKernelManager;
    this.installDir = opts.installDir;
  }

  // ===== 扫描(合并 cordis.yml + .disabled.json + node_modules 未声明包) =====

  protected scan(): KernelExtensionInfo[] {
    const cfg = this.dshConfigSource;
    const out: KernelExtensionInfo[] = [];
    const cordis = cfg.listPlugins();               // 启用
    const disabled = cfg.listDisabledPlugins();     // 禁用(曾移出 cordis.yml)
    const cordisNames = new Set(cordis.map((p) => p.name));
    const cordisIds = new Set(cordis.map((p) => p.id));
    const disabledNames = new Set(disabled.map((p) => p.name));

    for (const p of cordis) out.push(this.toInfo(p.id, p.name, true));
    for (const p of disabled) out.push(this.toInfo(p.id, p.name, false));
    // 「可用」折叠成禁用:node_modules 有包、但 cordis.yml 未声明且无禁用记录。
    for (const pkgName of this.availablePackages()) {
      if (cordisNames.has(pkgName) || disabledNames.has(pkgName)) continue;
      const resolvedId = cfg.resolvePluginId(pkgName);
      // 解析后 id 已被启用包占用 → 是库包/替代实现(如 dsh-subprocess 与 dsh-subprocess-local
      // 都回落 id「subprocess」),不列为「可用」,否则启用后会写重复 id、内核启动即崩。
      if (cordisIds.has(resolvedId)) continue;
      out.push(this.toInfo(resolvedId, pkgName, false));
    }
    return out;
  }

  private availablePackages(): string[] {
    return this.dshConfigSource.listAvailablePlugins().map((p) => p.name);
  }

  private toInfo(id: string, name: string, enabled: boolean): KernelExtensionInfo {
    const disallowOff = this.isProtected(id);
    // 相对路径块 = 桌面随附的 cordis 文件插件(非 npm 包):展示名/描述来自随附目录的
    // extension.json 单源,标签标 desktop(来源)+ file(形态);npm 包走 node_modules 元信息。
    if (isLocalEntry(name)) {
      const manifest = this.readExtensionManifest(name);
      return {
        id,
        name: manifest.displayName ?? this.displayNameFromId(id),
        description: manifest.description,
        enabled,
        disallowOff,
        tags: ["desktop", ...this.deriveTags("file", disallowOff)],
      };
    }
    const meta = this.readNodeMeta(name);
    return {
      id,
      name,
      version: meta.version,
      description: meta.description,
      enabled,
      disallowOff,
      tags: this.deriveTags("npm", disallowOff),
    };
  }

  /** 读随附插件目录里的 extension.json（{displayName, description}），缺失/损坏回空。 */
  private readExtensionManifest(name: string): Partial<DshExtensionManifest> {
    try {
      const entry = this.dshConfigSource.resolveEntryPath(name);
      const manifestPath = join(dirname(entry), "extension.json");
      if (!existsSync(manifestPath)) return {};
      const m = JSON.parse(readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
      return {
        displayName: typeof m.displayName === "string" ? m.displayName : undefined,
        description: typeof m.description === "string" ? m.description : undefined,
      };
    } catch {
      return {};
    }
  }

  /** 本地扩展展示名的兜底:cordis id 剥 my-harness-desktop- 前缀(ask/goal/read-claude-md/...)。
   *  有 extension.json 走 displayName;没写 manifest 也绝不回落裸路径(那是文件路径不是名字)。 */
  private displayNameFromId(id: string): string {
    return id.replace(/^my-harness-desktop-/, "");
  }

  private readNodeMeta(pkgName: string): { version?: string; description?: string } {
    if (!this.installDir || !pkgName.startsWith("@deepseek-ai/")) return {};
    const pkgPath = join(this.installDir, "node_modules", ...pkgName.split("/"), "package.json");
    if (!existsSync(pkgPath)) return {};
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as Record<string, unknown>;
      return {
        version: typeof pkg.version === "string" ? pkg.version : undefined,
        description: typeof pkg.description === "string" ? pkg.description : undefined,
      };
    } catch {
      return {};
    }
  }

  // ===== enable/disable(落盘机制) =====

  protected async doEnable(id: string): Promise<void> {
    const cfg = this.dshConfigSource;
    // 有禁用记录 → 还原
    if (cfg.listDisabledPlugins().some((p) => p.id === id)) {
      cfg.enablePlugin(id);
      return;
    }
    // node_modules 里未声明的包 → 新增 cordis 块(修 §0.7 的「点开关会炸」)
    const pkg = this.availablePackages().find((p) => cfg.resolvePluginId(p) === id);
    if (!pkg) throw new Error(`拓展 ${id} 不存在或未安装`);
    cfg.addPlugin(pkg);
  }

  protected async doDisable(id: string): Promise<void> {
    this.dshConfigSource.disablePlugin(id);
  }

  // ===== 安装/卸载(npm 进内核目录) =====

  protected async doInstall(source: string, onProgress: (line: string) => void): Promise<KernelExtensionMutationResult> {
    const r = await this.dshKernelManager.installPlugin(source, onProgress);
    if (!r.ok) return { ok: false, error: r.error ?? undefined };
    try {
      this.dshConfigSource.addPlugin(source);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  protected async doUninstall(id: string, onProgress: (line: string) => void): Promise<KernelExtensionMutationResult> {
    const cfg = this.dshConfigSource;
    const pkg = this.packageNameById(id);
    cfg.removePluginBlock(id);
    if (!pkg) return { ok: true }; // 相对路径随附插件:只摘 cordis 块(目录由随附通道管)
    const r = await this.dshKernelManager.uninstallPlugin(pkg, onProgress);
    return { ok: r.ok, error: r.error ?? undefined };
  }

  /** 按 cordis id 反查 npm 包名(用于 uninstall 时 npm uninstall)。 */
  private packageNameById(id: string): string | undefined {
    const cfg = this.dshConfigSource;
    const inCordis = cfg.listPlugins().find((p) => p.id === id);
    if (inCordis && inCordis.name.startsWith("@deepseek-ai/")) return inCordis.name;
    return this.availablePackages().find((p) => cfg.resolvePluginId(p) === id);
  }
}
