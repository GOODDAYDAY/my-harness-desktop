// pi 底座 settings 存储 —— application 层,Node fs 读写 ~/.pi/agent/settings.json。
//
// ⚠ 偏离文档路线(标注):文档说"壳不替底座管配置"(structure/18 §3.1.2),
// 但底座 SettingsManager 是公开 API、settings.json 是底座标准契约,桌面端写标准
// 字段不算重复领域知识(区别于"自己查 registry 比版本"那种重复)。用户明确要
// 在桌面端编辑 pi 所有配置,故实现 + 标注偏离。
//
// 关键纪律:
// - application 不 import electron(路径由 shell 注入)
// - Node 内置 fs(标准库)+ proper-lockfile 文件锁(防并发写撕裂)
// - 读整份 settings、写深合并(只改传入字段,不覆盖整份)
// - 路径 ~/.pi/agent/settings.json(底座标准,不是 ~/.my-harness-desktop)
// - 解析底座 settings-manager.d.ts 拿"当前底座版本所有字段"(方案 D:未知字段兜底,
//   .d.ts 有但描述表没有的 → 展示,底座升级新字段不丢)
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript";
import { deepMergeJson } from "../../core/application/config/json-merge";
import { withDirLock } from "../../core/application/config/config-file";
import type { SchemaField } from "../../core/domain/context";
export type { SchemaField } from "../../core/domain/context";

/**
 * 解析底座 settings-manager.d.ts,返回 Settings 接口的所有字段(含嵌套展平)。
 * 路径:优先 installDir(我们装的 ~/.my-harness-desktop/pi),回退全局 require.resolve。
 * globalResolvePaths 由 shell 注入(进程 cwd / npm 全局目录等),application 不读 process 环境。
 * 解析失败返回空数组(降级:只用描述表 + settings.json 兜底,不脆)。
 */
export function parseSettingsSchema(
  installDir: string | null,
  globalResolvePaths: string[] = [],
): SchemaField[] {
  const dtsPath = findSettingsDts(installDir, globalResolvePaths);
  if (!dtsPath) return [];
  try {
    const src = readFileSync(dtsPath, "utf-8");
    return parseSettingsInterfaces(src);
  } catch {
    return [];
  }
}

/** 找 settings-manager.d.ts 路径:优先 installDir,回退注入的全局 resolve paths。 */
function findSettingsDts(installDir: string | null, globalResolvePaths: string[]): string | null {
  const candidates: string[] = [];
  if (installDir) {
    candidates.push(
      join(installDir, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "core", "settings-manager.d.ts"),
    );
  }
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  try {
    const pkgRoot = require.resolve("@earendil-works/pi-coding-agent/package.json", {
      paths: globalResolvePaths,
    });
    return join(pkgRoot, "..", "dist", "core", "settings-manager.d.ts");
  } catch {
    return null;
  }
}

/**
 * 解析 .d.ts 文本(TS Compiler API):提 interface 名→字段列表,展平嵌套
 * (Settings 的嵌套字段类型如 CompactionSettings 展成 compaction.enabled/
 * compaction.reserveTokens)。interface extends 时并入基类字段。
 */
function parseSettingsInterfaces(src: string): SchemaField[] {
  const sf = ts.createSourceFile("settings-manager.d.ts", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const ifaces = new Map<string, ts.InterfaceDeclaration>();
  sf.forEachChild((node) => {
    if (ts.isInterfaceDeclaration(node)) ifaces.set(node.name.text, node);
  });
  const settings = ifaces.get("Settings");
  if (!settings) return [];

  const propName = (m: ts.TypeElement): string | null =>
    ts.isPropertySignature(m) && m.name ? m.name.getText(sf).replace(/^["']|["']$/g, "") : null;

  const membersOf = (decl: ts.InterfaceDeclaration): ts.PropertySignature[] => {
    const members = decl.members.filter(ts.isPropertySignature);
    for (const heritage of decl.heritageClauses ?? []) {
      for (const t of heritage.types) {
        const base = ifaces.get(t.expression.getText(sf));
        if (base) members.push(...membersOf(base));
      }
    }
    return members;
  };

  const out: SchemaField[] = [];
  for (const m of membersOf(settings)) {
    const name = propName(m);
    if (!name) continue;
    const typeText = m.type?.getText(sf) ?? "";
    const nested = ifaces.get(typeText);
    if (nested) {
      for (const sm of membersOf(nested)) {
        const sname = propName(sm);
        if (sname) out.push({ key: `${name}.${sname}`, type: sm.type?.getText(sf) ?? "" });
      }
    } else {
      out.push({ key: name, type: typeText });
    }
  }
  return out;
}

/** pi 底座 settings(宽松类型,实际字段见底座 settings-manager.d.ts)。 */
export type PiSettings = Record<string, unknown>;

/**
 * pi 底座 settings 存储。构造接受 agentDir(~/.pi/agent),由 shell 注入。
 * get 同步读(单进程安全),set 异步写(深合并 + 文件锁)。
 */
export class PiSettingsStore {
  private agentDir: string;
  private get filePath(): string {
    return join(this.agentDir, "settings.json");
  }

  constructor(opts: { agentDir: string }) {
    this.agentDir = opts.agentDir;
  }

  /** 读整份 settings。文件不存在或损坏返回空对象(不抛错,设置页显示空)。 */
  get(): PiSettings {
    const file = this.filePath;
    if (!existsSync(file)) return {};
    try {
      return JSON.parse(readFileSync(file, "utf-8")) as PiSettings;
    } catch (err) {
      console.warn(`[pi-settings] settings.json 损坏已忽略:${file}`, err);
      return {};
    }
  }

  /** 深合并写入:只覆盖传入的 key,不整份替换。写盘失败抛错。 */
  async set(patch: PiSettings): Promise<void> {
    const file = this.filePath;
    if (!existsSync(this.agentDir)) mkdirSync(this.agentDir, { recursive: true });
    // 锁目录(settings.json 可能不存在,锁目录已存在);withDirLock 串行化并发写。
    await withDirLock(this.agentDir, async () => {
      const current = this.get();
      const merged = deepMergeJson(current, patch);
      await writeFile(file, JSON.stringify(merged, null, 2), "utf-8");
    });
  }
}
