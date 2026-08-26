// dsh-extension-installer 单测:syncFitDshExtension 单块挂载 + reconcile 摘旧四块。
// 用 vi.mock 把 homedir 指到临时目录,不碰真实 ~/.dsh;cordis.yml 落在临时目录的 .dsh 下,
// 与 PLUGINS_ROOT(homedir()/.dsh/.my-harness-desktop-plugins)保持「blockName 相对 cordis.yml」的一致。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DshConfigSource } from "./dsh-config-source";
import { syncFitDshExtension, reconcilePluginDshExtensions, FIT_DSEXTENSION_ID } from "./dsh-extension-installer";

const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => home.dir };
});

const MARKER = ".my-harness-desktop-plugin";

let dir: string;
let cordisPath: string;
let dshConfig: DshConfigSource;
let pluginsRoot: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dsh-fit-ext-"));
  home.dir = dir;
  mkdirSync(join(dir, ".dsh"), { recursive: true });
  cordisPath = join(dir, ".dsh", "cordis.yml");
  writeFileSync(cordisPath, "");
  dshConfig = new DshConfigSource(cordisPath);
  pluginsRoot = join(dir, ".dsh", ".my-harness-desktop-plugins");
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/** 造一个最小 cordis 插件源目录(index.mjs + extension.json)。 */
function makeSource(sourceDir: string): void {
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(join(sourceDir, "index.mjs"), "export const name = 'test';\nexport function apply() {}\n", "utf8");
  writeFileSync(join(sourceDir, "extension.json"), JSON.stringify({ displayName: "test", description: "" }), "utf8");
}

describe("syncFitDshExtension(统一适配插件单块挂载)", () => {
  it("同步目录到 my-harness-fit-dsh-extension + cordis.yml 只挂一块", () => {
    const source = join(dir, "src-dsh-extension");
    makeSource(source);
    const res = syncFitDshExtension(source, dshConfig);

    expect(res.installed).toBe(true);
    expect(existsSync(join(pluginsRoot, FIT_DSEXTENSION_ID, "index.mjs"))).toBe(true);
    expect(existsSync(join(pluginsRoot, FIT_DSEXTENSION_ID, MARKER))).toBe(true);

    const text = readFileSync(cordisPath, "utf8");
    expect(text).toContain(`- id: ${FIT_DSEXTENSION_ID}`);
    expect(text).toContain(`name: './.my-harness-desktop-plugins/${FIT_DSEXTENSION_ID}/index.mjs'`);
    // 单一块:该 id 只出现一次。
    expect(text.split(`- id: ${FIT_DSEXTENSION_ID}`).length).toBe(2);
  });

  it("幂等:重复同步不重复追加块", () => {
    const source = join(dir, "src-dsh-extension");
    makeSource(source);
    syncFitDshExtension(source, dshConfig);
    syncFitDshExtension(source, dshConfig);
    const text = readFileSync(cordisPath, "utf8");
    expect(text.split(`- id: ${FIT_DSEXTENSION_ID}`).length).toBe(2);
  });
});

describe("reconcilePluginDshExtensions(启动对账摘旧四块)", () => {
  /** 预置一个「旧随插件携带」的目录(带 marker) + 对应 cordis 块,模拟合并前的安装残留。 */
  function seedLegacy(id: string, blockId: string): void {
    const target = join(pluginsRoot, id);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "index.mjs"), "export const name = 'legacy';\n", "utf8");
    writeFileSync(join(target, MARKER), id, "utf8");
    dshConfig.addPluginBlock(blockId, `./.my-harness-desktop-plugins/${id}/index.mjs`);
  }

  it("摘除旧 ask/goal/read-claude-md/skill-manager 四目录 + 四块,保留统一块", () => {
    // 预置四个旧目录 + 统一目录(active)
    const legacyIds = ["ask", "goal", "read-claude-md", "skill-manager"];
    for (const id of legacyIds) seedLegacy(id, `my-harness-desktop-${id}`);
    const source = join(dir, "src-dsh-extension");
    makeSource(source);
    syncFitDshExtension(source, dshConfig);

    reconcilePluginDshExtensions(new Set([FIT_DSEXTENSION_ID]), dshConfig);

    // 四个旧目录被摘,统一目录保留
    for (const id of legacyIds) {
      expect(existsSync(join(pluginsRoot, id))).toBe(false);
    }
    expect(existsSync(join(pluginsRoot, FIT_DSEXTENSION_ID))).toBe(true);

    // 四个旧块被摘,统一块保留
    const text = readFileSync(cordisPath, "utf8");
    for (const id of legacyIds) {
      expect(text).not.toContain(`- id: my-harness-desktop-${id}`);
    }
    expect(text).toContain(`- id: ${FIT_DSEXTENSION_ID}`);
  });
});
