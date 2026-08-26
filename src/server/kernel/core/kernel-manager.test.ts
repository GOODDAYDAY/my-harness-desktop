// KernelManager 基类的 resolveCustomCli / status 裸单测(docs/design/custom-cli-path.md §5):
// 用 PiKernelManager(具体实现)驱动基类通用逻辑,fixture 用 tmp 目录真文件,不 mock 环境。
// 测试 import client 实现是允许的(同 model-catalog.test.ts 先例:测试验证具体内核行为)。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiKernelManager, PI_SPEC } from "../pi/manager/pi-kernel";

let dir: string;
let manager: PiKernelManager;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "custom-cli-"));
  // installDir(数据根)与自定义目录在 fixture 里都用 dir:currentVersion 读 installDir,
  // resolveCustomCli 读传入的自定义目录。
  manager = new PiKernelManager(PI_SPEC, dir);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 形态一 fixture:dir/dist/cli.js + dir/package.json。 */
function makeSourceRoot(version?: string): void {
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "dist", "cli.js"), "// cli");
  if (version !== undefined) {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "pi-coding-agent", version }));
  }
}

/** 形态二 fixture:dir/node_modules/@earendil-works/pi-coding-agent/{dist/cli.js,package.json}。 */
function makeNpmInstall(version?: string): void {
  const pkgRoot = join(dir, "node_modules", "@earendil-works", "pi-coding-agent");
  mkdirSync(join(pkgRoot, "dist"), { recursive: true });
  writeFileSync(join(pkgRoot, "dist", "cli.js"), "// cli");
  if (version !== undefined) {
    writeFileSync(join(pkgRoot, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version }));
  }
}

/** 数据根 fixture(与形态二同构,数据根本身就是一份 npm 安装目录)。 */
function makeInstalledDataRoot(version: string): void {
  makeNpmInstall(version);
}

describe("resolveCustomCli", () => {
  it("形态一 包源码根:命中,返回 cliJs 绝对路径与版本", () => {
    makeSourceRoot("0.81.0");
    const r = manager.resolveCustomCli(dir);
    expect(r).toEqual({ cliJs: join(dir, "dist", "cli.js"), version: "0.81.0" });
  });

  it("形态二 npm 安装目录:命中", () => {
    makeNpmInstall("0.80.7");
    const r = manager.resolveCustomCli(dir);
    expect(r).toEqual({
      cliJs: join(dir, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"),
      version: "0.80.7",
    });
  });

  it("两形态同时命中:取形态一(开发意图优先)", () => {
    makeSourceRoot("0.81.0-dev");
    makeNpmInstall("0.80.7");
    const r = manager.resolveCustomCli(dir);
    expect(r?.cliJs).toBe(join(dir, "dist", "cli.js"));
    expect(r?.version).toBe("0.81.0-dev");
  });

  it("cli.js 在但 package.json 缺失:命中,version 为 null(宽松,不判无效)", () => {
    makeSourceRoot();
    const r = manager.resolveCustomCli(dir);
    expect(r?.cliJs).toBe(join(dir, "dist", "cli.js"));
    expect(r?.version).toBeNull();
  });

  it("package.json 损坏:命中,version 为 null", () => {
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "dist", "cli.js"), "// cli");
    writeFileSync(join(dir, "package.json"), "{ not json");
    expect(manager.resolveCustomCli(dir)?.version).toBeNull();
  });

  it("两种形态都不存在:返回 null", () => {
    expect(manager.resolveCustomCli(dir)).toBeNull();
  });

  it("只有 package.json 没有 cli.js:返回 null(判据是 cli.js 在不在)", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "pi-coding-agent", version: "0.81.0" }));
    expect(manager.resolveCustomCli(dir)).toBeNull();
  });
});

describe("status", () => {
  it("customCliDir 为空:数据根状态,source=installed,双版本同值", () => {
    makeInstalledDataRoot("0.80.7");
    const s = manager.status("");
    expect(s.source).toBe("installed");
    expect(s.customCliDir).toBe("");
    expect(s.currentVersion).toBe("0.80.7");
    expect(s.installedVersion).toBe("0.80.7");
    expect(s.available).toBe(true);
    expect(s.error).toBeNull();
  });

  it("自定义命中:source=custom,currentVersion 取自定义,installedVersion 照常给数据根", () => {
    makeInstalledDataRoot("0.80.7");
    const customDir = mkdtempSync(join(tmpdir(), "custom-cli-other-"));
    try {
      mkdirSync(join(customDir, "dist"), { recursive: true });
      writeFileSync(join(customDir, "dist", "cli.js"), "// cli");
      writeFileSync(join(customDir, "package.json"), JSON.stringify({ version: "0.81.0-dev" }));
      const s = manager.status(customDir);
      expect(s.source).toBe("custom");
      expect(s.customCliDir).toBe(customDir);
      expect(s.currentVersion).toBe("0.81.0-dev");
      expect(s.installedVersion).toBe("0.80.7");
      expect(s.available).toBe(true);
      expect(s.error).toBeNull();
    } finally {
      rmSync(customDir, { recursive: true, force: true });
    }
  });

  it("自定义失效(目录被删):source 保留 custom,状态跟随数据根,error 标注已回落", () => {
    makeInstalledDataRoot("0.80.7");
    const s = manager.status(join(dir, "not-exists"));
    expect(s.source).toBe("custom");
    expect(s.currentVersion).toBe("0.80.7");
    expect(s.installedVersion).toBe("0.80.7");
    expect(s.available).toBe(true);
    expect(s.error).toContain("回落");
  });

  it("数据根未安装 + 自定义失效:available=false,error 标注回落", () => {
    const s = manager.status(join(dir, "not-exists"));
    expect(s.available).toBe(false);
    expect(s.error).toContain("回落");
  });
});
