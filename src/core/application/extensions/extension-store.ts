// Extension 发现与 CRUD —— application 层。
//
// 依据 docs/core/extension-management.md §4.2(发现)、§4.3(enable/disable)、§4.4(排序)。
// 扫描 ~/.pi/agent/extensions/ + 读 settings.json packages/_disabled_packages。
// enable/disable:settings-packages 走数组移动;extensions-dir 走文件移动到 .disabled/。
// 排序:重写 packages 数组顺序,不触发 restart。
// 不 import electron:路径由 shell 注入(agentDir)。
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, lstatSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionInfo, ExtensionSource } from "../../domain/extensions";
import { PiSettingsStore } from "../pi-settings/pi-settings-store";

/** 变更回调类型:extension 配置变了时调用(通知 restart-coordinator)。 */
export type OnConfigChanged = (reason: string) => void;

export class ExtensionStore {
  private agentDir: string;
  private piSettings: PiSettingsStore;
  private onConfigChanged?: OnConfigChanged;

  constructor(opts: { agentDir: string; piSettings: PiSettingsStore; onConfigChanged?: OnConfigChanged }) {
    this.agentDir = opts.agentDir;
    this.piSettings = opts.piSettings;
    this.onConfigChanged = opts.onConfigChanged;
  }

  private get extensionsDir(): string {
    return join(this.agentDir, "extensions");
  }

  private get disabledDir(): string {
    return join(this.extensionsDir, ".disabled");
  }

  /** 扫描所有 extension,返回统一列表(§4.2)。 */
  scanExtensions(): ExtensionInfo[] {
    const fromSettings = this.scanSettingsPackages();
    const fromDir = this.scanExtensionsDir();
    return [...fromSettings, ...fromDir];
  }

  /** 扫描 settings.json 的 packages + _disabled_packages(§4.2)。 */
  private scanSettingsPackages(): ExtensionInfo[] {
    const settings = this.piSettings.get();
    const enabled = this.parsePackageArray(settings["packages"]);
    const disabled = this.parsePackageArray(settings["_disabled_packages"]);
    const out: ExtensionInfo[] = [];

    for (const source of enabled) {
      out.push(this.resolveSettingsSource(source, true));
    }
    for (const source of disabled) {
      out.push(this.resolveSettingsSource(source, false));
    }
    return out;
  }

  /** 扫描 ~/.pi/agent/extensions/ 目录的一层子条目(§4.2)。 */
  private scanExtensionsDir(): ExtensionInfo[] {
    if (!existsSync(this.extensionsDir)) return [];
    const out: ExtensionInfo[] = [];
    const disabled = this.scanDisabledDir();

    for (const entry of readdirSync(this.extensionsDir)) {
      if (entry === ".disabled") continue;
      const full = join(this.extensionsDir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isFile() && entry.endsWith(".ts")) {
        out.push({
          source: full,
          name: entry.replace(/\.ts$/, ""),
          sourceType: "file",
          enabled: true,
          origin: "extensions-dir",
        });
      } else if (st.isDirectory() || lstatSync(full).isSymbolicLink()) {
        const pkgPath = lstatSync(full).isSymbolicLink()
          ? this.resolveSymlinkPackageJson(full)
          : join(full, "package.json");
        const meta = this.readPackageMeta(pkgPath);
        out.push({
          source: full,
          name: meta.name ?? entry,
          version: meta.version,
          description: meta.description,
          sourceType: "local",
          enabled: true,
          origin: "extensions-dir",
        });
      }
    }

    out.push(...disabled);
    return out;
  }

  /** 扫描 .disabled/ 子目录(被禁用的 loose 文件)。 */
  private scanDisabledDir(): ExtensionInfo[] {
    if (!existsSync(this.disabledDir)) return [];
    const out: ExtensionInfo[] = [];
    for (const entry of readdirSync(this.disabledDir)) {
      const full = join(this.disabledDir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isFile() && entry.endsWith(".ts")) {
        out.push({
          source: full,
          name: entry.replace(/\.ts$/, ""),
          sourceType: "file",
          enabled: false,
          origin: "extensions-dir",
        });
      } else if (st.isDirectory() || lstatSync(full).isSymbolicLink()) {
        const pkgPath = lstatSync(full).isSymbolicLink()
          ? this.resolveSymlinkPackageJson(full)
          : join(full, "package.json");
        const meta = this.readPackageMeta(pkgPath);
        out.push({
          source: full,
          name: meta.name ?? entry,
          version: meta.version,
          description: meta.description,
          sourceType: "local",
          enabled: false,
          origin: "extensions-dir",
        });
      }
    }
    return out;
  }

  /** 解析 settings.json 的 packages 数组元素(支持 string 和 object 形态)。 */
  private parsePackageArray(raw: unknown): string[] {
    if (!Array.isArray(raw)) return [];
    return raw
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object" && "source" in item) {
          return String((item as Record<string, unknown>)["source"]);
        }
        return null;
      })
      .filter((s): s is string => s !== null);
  }

  /** 判断 source 是否为受保护 extension(不允许关闭)。
   *  tool-gate:desktop 工具过滤的基础设施,desktop 启动时 installer 强制同步——
   *  允许禁用会被下次启动静默重装,禁用语义自相矛盾,故不可关。 */
  private isProtected(source: string): boolean {
    const PROTECTED = ["read-claude-md", "tool-gate"];
    const name = source.split("/").pop() ?? source;
    return PROTECTED.includes(name);
  }

  /** 判断 source 类型(§4.2)。 */
  private detectSourceType(source: string): ExtensionSource {
    if (source.startsWith("git+") || source.endsWith(".git")) return "git";
    if (source.startsWith("@") && source.includes("/")) return "npm";
    if (source.startsWith("/") || source.includes("/") || source.includes("\\") || source.startsWith(".")) {
      return "local";
    }
    return "npm";
  }

  /** 从 settings.json 的 source 解析出 ExtensionInfo。 */
  private resolveSettingsSource(source: string, enabled: boolean): ExtensionInfo {
    const sourceType = this.detectSourceType(source);
    let name = source;
    let version: string | undefined;
    let description: string | undefined;

    if (sourceType === "local") {
      const meta = this.readPackageMeta(join(source, "package.json"));
      name = meta.name ?? source;
      version = meta.version;
      description = meta.description;
    } else if (sourceType === "npm") {
      name = source;
    } else if (sourceType === "git") {
      const m = source.match(/[/#]([^/]+?)(?:\.git)?(?:[#@].*)?$/);
      name = m ? m[1] : source;
    }

    return { source, name, version, description, sourceType, enabled, origin: "settings-packages", disallowOff: this.isProtected(source) };
  }

  /** 读 package.json 的 name/version/description。 */
  private readPackageMeta(pkgPath: string): { name?: string; version?: string; description?: string } {
    if (!existsSync(pkgPath)) return {};
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as Record<string, unknown>;
      return {
        name: typeof pkg["name"] === "string" ? pkg["name"] : undefined,
        version: typeof pkg["version"] === "string" ? pkg["version"] : undefined,
        description: typeof pkg["description"] === "string" ? pkg["description"] : undefined,
      };
    } catch {
      return {};
    }
  }

  /** 符号链接:读链接目标的 package.json。 */
  private resolveSymlinkPackageJson(linkPath: string): string {
    try {
      const target = readlinkSync(linkPath);
      return join(target, "package.json");
    } catch {
      return join(linkPath, "package.json");
    }
  }

  // ============ enable/disable ============

  /** 启用一个 extension(§4.3)。 */
  async enable(source: string): Promise<void> {
    const info = this.scanExtensions().find((e) => e.source === source);
    if (!info) return;
    if (info.enabled) return;

    if (info.origin === "settings-packages") {
      await this.moveBetweenArrays(source, "_disabled_packages", "packages");
    } else {
      const filename = source.split("/").pop() ?? source;
      await this.moveFile(join(this.disabledDir, filename), join(this.extensionsDir, filename));
    }
    this.onConfigChanged?.("extension 启用");
  }

  /** 禁用一个 extension(§4.3)。 */
  async disable(source: string): Promise<void> {
    const info = this.scanExtensions().find((e) => e.source === source);
    if (!info) return;
    if (!info.enabled) return;
    if (info.disallowOff) return;

    if (info.origin === "settings-packages") {
      await this.moveBetweenArrays(source, "packages", "_disabled_packages");
    } else {
      if (!existsSync(this.disabledDir)) mkdirSync(this.disabledDir, { recursive: true });
      const filename = source.split("/").pop() ?? source;
      await this.moveFile(join(this.extensionsDir, filename), join(this.disabledDir, filename));
    }
    this.onConfigChanged?.("extension 禁用");
  }

  /** 在 settings.json 的两个数组之间移动 source。 */
  private async moveBetweenArrays(source: string, fromKey: string, toKey: string): Promise<void> {
    const settings = this.piSettings.get();
    const fromArr = this.parsePackageArray(settings[fromKey]).filter((s) => s !== source);
    const toArr = this.parsePackageArray(settings[toKey]);
    if (!toArr.includes(source)) toArr.push(source);
    await this.piSettings.set({ [fromKey]: fromArr, [toKey]: toArr } as Record<string, unknown>);
  }

  /** 原子文件移动(rename,同文件系统内)。 */
  private async moveFile(from: string, to: string): Promise<void> {
    if (!existsSync(from)) return;
    renameSync(from, to);
  }

  // ============ 排序 ============

  /** 重排 packages 数组顺序(§4.4)。不触发 restart——顺序不影响加载行为。 */
  async reorder(orderedSources: string[]): Promise<void> {
    await this.piSettings.set({ packages: orderedSources } as Record<string, unknown>);
  }
}
