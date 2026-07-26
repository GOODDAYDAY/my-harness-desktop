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
// - 路径 ~/.pi/agent/settings.json(底座标准,不是 ~/.pi-desktop)
// - 解析底座 settings-manager.d.ts 拿"当前底座版本所有字段"(方案 D:未知字段兜底,
//   .d.ts 有但描述表没有的 → 展示,底座升级新字段不丢)
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as lockfile from "proper-lockfile";

/** 底座 .d.ts 解析出的字段(扁平,含嵌套路径)。 */
export interface SchemaField {
  /** 扁平 key,如 compaction.enabled */
  key: string;
  /** TS 类型(boolean/number/string/枚举/数组/嵌套) */
  type: string;
}

/**
 * 解析底座 settings-manager.d.ts,返回 Settings 接口的所有字段(含嵌套展平)。
 * 路径:优先 installDir(我们装的 ~/.pi-desktop/pi),回退全局 require.resolve。
 * 解析失败返回空数组(降级:只用描述表 + settings.json 兜底,不脆)。
 */
export function parseSettingsSchema(installDir: string | null): SchemaField[] {
  const dtsPath = findSettingsDts(installDir);
  if (!dtsPath) return [];
  try {
    const src = readFileSync(dtsPath, "utf-8");
    return parseSettingsInterfaces(src);
  } catch {
    return [];
  }
}

/** 找 settings-manager.d.ts 路径:优先 installDir,回退全局 resolve。 */
function findSettingsDts(installDir: string | null): string | null {
  const candidates: string[] = [];
  if (installDir) {
    candidates.push(
      join(installDir, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "core", "settings-manager.d.ts"),
    );
  }
  // 回退:全局 require.resolve(用户 npm i -g 装的)
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  try {
    const pkgRoot = require.resolve("@earendil-works/pi-coding-agent/package.json", {
      paths: [process.cwd(), join(process.env["HOME"] ?? "", ".npm-global"), "/usr/local/lib"],
    });
    return join(pkgRoot, "..", "dist", "core", "settings-manager.d.ts");
  } catch {
    return null;
  }
}

/**
 * 解析 .d.ts 文本:提 interface 名→字段列表,展平嵌套(Settings 的嵌套字段类型
 * 如 CompactionSettings 展成 compaction.enabled/compaction.reserveTokens)。
 */
function parseSettingsInterfaces(src: string): SchemaField[] {
  const out: SchemaField[] = [];
  // 匹配所有 interface 定义:interface Name { fields }
  const ifaceRe = /export interface (\w+) \{([^}]*)\}/g;
  const ifaces = new Map<string, { fields: string; } >();
  let m: RegExpExecArray | null;
  while ((m = ifaceRe.exec(src)) !== null) {
    ifaces.set(m[1], { fields: m[2] });
  }
  const settings = ifaces.get("Settings");
  if (!settings) return [];
  // 解析 Settings 顶层字段
  // fieldRe: "    fieldName?: Type;"
  const fieldRe = /^\s*(\w+)\??\s*:\s*([^;]+);/gm;
  const topFields: { name: string; type: string }[] = [];
  let fm: RegExpExecArray | null;
  while ((fm = fieldRe.exec(settings.fields)) !== null) {
    topFields.push({ name: fm[1], type: fm[2].trim() });
  }
  // 展平:嵌套类型(类型名是另一个 interface)展成 path.subfield
  for (const f of topFields) {
    const nested = ifaces.get(f.type);
    if (nested) {
      // 嵌套对象:展平子字段
      let subm: RegExpExecArray | null;
      const subFieldRe = /^\s*(\w+)\??\s*:\s*([^;]+);/gm;
      while ((subm = subFieldRe.exec(nested.fields)) !== null) {
        out.push({ key: `${f.name}.${subm[1]}`, type: subm[2].trim() });
      }
    } else {
      out.push({ key: f.name, type: f.type });
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
    let release: (() => Promise<void>) | null = null;
    try {
      // 锁文件(settings.json 可能不存在,锁目录已存在)
      release = await lockfile.lock(this.agentDir, { stale: 5000 });
      const current = this.get();
      const merged = deepMerge(current, patch);
      await writeFile(file, JSON.stringify(merged, null, 2), "utf-8");
    } finally {
      if (release) await release();
    }
  }
}

/** 深合并:patch 覆盖 current,嵌套对象递归合并(不整替)。 */
function deepMerge(current: PiSettings, patch: PiSettings): PiSettings {
  const out: PiSettings = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === "object" && !Array.isArray(v) && out[k] && typeof out[k] === "object" && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k] as PiSettings, v as PiSettings);
    } else {
      out[k] = v;
    }
  }
  return out;
}
