// client/pi/pi-extension-manager.ts —— pi 内核拓展源(实现层)。
//
// 把原 application 层的 ExtensionStore 迁到 client/pi(pi 专属扫描逻辑不再污染 application),
// 改成 extends KernelExtensionManager(基类):pi 只填「数据从哪扫 + 开关怎么落盘 + 装/卸怎么执行」,
// 排序/标签派生/受保护/重启协调全由基类承担(docs/core/extension-management.md §0.6)。
//
// 依赖方向只向内:client import core/application(基类)+ core/domain(契约)+ 同层 pi-cli。

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, lstatSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { KernelExtensionManager } from "../../application/extensions/kernel-extension-manager";
import type { KernelExtensionInfo, KernelExtensionCapabilities, KernelExtensionMutationResult } from "@my-harness-desktop/shared";
import type { PiSettingsStore } from "./pi-settings-store";
import { runPiCli } from "./pi-cli";

/** pi 侧受保护名单(禁关/禁卸):read-claude-md 加载 CLAUDE.md,tool-gate 是工具过滤基础设施。 */
const PI_PROTECTED = ["read-claude-md", "tool-gate"];

/** 来源类型(用于基类 deriveTags;值即 tag 展示值)。 */
type PiSourceType = "file" | "local" | "npm" | "git";

export interface PiExtensionManagerOptions {
  agentDir: string;
  piSettings: PiSettingsStore;
  onConfigChanged?: (reason: string) => void;
}

export class PiExtensionManager extends KernelExtensionManager {
  readonly capabilities: KernelExtensionCapabilities = { update: false, reorder: false };

  private readonly agentDir: string;
  private readonly piSettings: PiSettingsStore;

  constructor(opts: PiExtensionManagerOptions) {
    super({ protectedIds: new Set(PI_PROTECTED), onConfigChanged: opts.onConfigChanged });
    this.agentDir = opts.agentDir;
    this.piSettings = opts.piSettings;
  }

  private get extensionsDir(): string {
    return join(this.agentDir, "extensions");
  }

  private get disabledDir(): string {
    return join(this.extensionsDir, ".disabled");
  }

  // ===== 扫描(合并 settings.json 两个数组 + extensions 目录) =====

  protected scan(): KernelExtensionInfo[] {
    return [...this.scanSettingsPackages(), ...this.scanExtensionsDir()];
  }

  private scanSettingsPackages(): KernelExtensionInfo[] {
    const settings = this.piSettings.get();
    const enabled = this.parsePackageArray(settings["packages"]);
    const disabled = this.parsePackageArray(settings["_disabled_packages"]);
    const out: KernelExtensionInfo[] = [];
    for (const source of enabled) out.push(this.resolveSettingsSource(source, true));
    for (const source of disabled) out.push(this.resolveSettingsSource(source, false));
    return out;
  }

  private scanExtensionsDir(): KernelExtensionInfo[] {
    if (!existsSync(this.extensionsDir)) return [];
    const out: KernelExtensionInfo[] = [];
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
        const disallowOff = this.isProtected(full);
        out.push({
          id: full,
          name: entry.replace(/\.ts$/, ""),
          enabled: true,
          disallowOff,
          tags: this.deriveTags("file", disallowOff),
        });
      } else if (st.isDirectory() || lstatSync(full).isSymbolicLink()) {
        const pkgPath = lstatSync(full).isSymbolicLink()
          ? this.resolveSymlinkPackageJson(full)
          : join(full, "package.json");
        const meta = this.readPackageMeta(pkgPath);
        const disallowOff = this.isProtected(full);
        out.push({
          id: full,
          name: meta.name ?? entry,
          version: meta.version,
          description: meta.description,
          enabled: true,
          disallowOff,
          tags: this.deriveTags("local", disallowOff),
        });
      }
    }

    out.push(...disabled);
    return out;
  }

  private scanDisabledDir(): KernelExtensionInfo[] {
    if (!existsSync(this.disabledDir)) return [];
    const out: KernelExtensionInfo[] = [];
    for (const entry of readdirSync(this.disabledDir)) {
      const full = join(this.disabledDir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isFile() && entry.endsWith(".ts")) {
        const disallowOff = this.isProtected(full);
        out.push({
          id: full,
          name: entry.replace(/\.ts$/, ""),
          enabled: false,
          disallowOff,
          tags: this.deriveTags("file", disallowOff),
        });
      } else if (st.isDirectory() || lstatSync(full).isSymbolicLink()) {
        const pkgPath = lstatSync(full).isSymbolicLink()
          ? this.resolveSymlinkPackageJson(full)
          : join(full, "package.json");
        const meta = this.readPackageMeta(pkgPath);
        const disallowOff = this.isProtected(full);
        out.push({
          id: full,
          name: meta.name ?? entry,
          version: meta.version,
          description: meta.description,
          enabled: false,
          disallowOff,
          tags: this.deriveTags("local", disallowOff),
        });
      }
    }
    return out;
  }

  // ===== 元信息 / source 解析 =====

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

  private detectSourceType(source: string): PiSourceType {
    if (source.startsWith("git+") || source.endsWith(".git")) return "git";
    if (source.startsWith("@") && source.includes("/")) return "npm";
    if (source.startsWith("/") || source.includes("/") || source.includes("\\") || source.startsWith(".")) {
      return "local";
    }
    return "npm";
  }

  private resolveSettingsSource(source: string, enabled: boolean): KernelExtensionInfo {
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

    const disallowOff = this.isProtected(source);
    return { id: source, name, version, description, enabled, disallowOff, tags: this.deriveTags(sourceType, disallowOff) };
  }

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

  private resolveSymlinkPackageJson(linkPath: string): string {
    try {
      const target = readlinkSync(linkPath);
      return join(target, "package.json");
    } catch {
      return join(linkPath, "package.json");
    }
  }

  // ===== enable/disable(落盘机制) =====

  protected async doEnable(id: string): Promise<void> {
    const info = this.scan().find((e) => e.id === id);
    if (!info || info.enabled) return;

    if (this.isSettingsPackage(id)) {
      await this.moveBetweenArrays(id, "_disabled_packages", "packages");
    } else {
      const filename = id.split("/").pop() ?? id;
      await this.moveFile(join(this.disabledDir, filename), join(this.extensionsDir, filename));
    }
  }

  protected async doDisable(id: string): Promise<void> {
    const info = this.scan().find((e) => e.id === id);
    if (!info || !info.enabled) return;

    if (this.isSettingsPackage(id)) {
      await this.moveBetweenArrays(id, "packages", "_disabled_packages");
    } else {
      if (!existsSync(this.disabledDir)) mkdirSync(this.disabledDir, { recursive: true });
      const filename = id.split("/").pop() ?? id;
      await this.moveFile(join(this.extensionsDir, filename), join(this.disabledDir, filename));
    }
  }

  /** 判断一个 id(source)是否为 settings.json packages 来源(而非 extensions 目录 loose 文件)。 */
  private isSettingsPackage(id: string): boolean {
    const settings = this.piSettings.get();
    const enabled = this.parsePackageArray(settings["packages"]);
    const disabled = this.parsePackageArray(settings["_disabled_packages"]);
    return enabled.includes(id) || disabled.includes(id);
  }

  private async moveBetweenArrays(source: string, fromKey: string, toKey: string): Promise<void> {
    const settings = this.piSettings.get();
    const fromArr = this.parsePackageArray(settings[fromKey]).filter((s) => s !== source);
    const toArr = this.parsePackageArray(settings[toKey]);
    if (!toArr.includes(source)) toArr.push(source);
    await this.piSettings.set({ [fromKey]: fromArr, [toKey]: toArr } as Record<string, unknown>);
  }

  private async moveFile(from: string, to: string): Promise<void> {
    if (!existsSync(from)) return;
    renameSync(from, to);
  }

  // ===== 安装/卸载(pi CLI 通道) =====

  protected async doInstall(source: string, onProgress: (line: string) => void): Promise<KernelExtensionMutationResult> {
    const r = await runPiCli(["install", source], onProgress);
    return { ok: r.ok, error: r.error ?? undefined };
  }

  protected async doUninstall(id: string, onProgress: (line: string) => void): Promise<KernelExtensionMutationResult> {
    const r = await runPiCli(["remove", id], onProgress);
    return { ok: r.ok, error: r.error ?? undefined };
  }
}
