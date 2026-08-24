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
 * 用 ts.createProgram + type checker 解析:能自动追 import 的外部类型别名(如 ThinkingLevel
 * / Transport),把字面量联合/枚举提成通用数据型 + enumValues。字段清单以内核 .d.ts 为唯一源。
 * 路径:优先 installDir(我们装的 ~/.my-harness-desktop/pi),回退全局 require.resolve。
 * globalResolvePaths 由 shell 注入(进程 cwd / npm 全局目录等),application 不读 process 环境。
 * 解析失败返回空数组(降级:配置表单退化成通用 JSON 兜底,不脆)。
 */
export function parseSettingsSchema(
  installDir: string | null,
  globalResolvePaths: string[] = [],
): SchemaField[] {
  const dtsPath = findSettingsDts(installDir, globalResolvePaths);
  if (!dtsPath) return [];
  try {
    return parseSettingsInterfaces(dtsPath);
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
 * 解析 .d.ts(ts.createProgram + checker):把 Settings 接口展平成字段清单。
 * 嵌套 interface(CompactionSettings 等)展成 dotted key(compaction.enabled);
 * 字面量联合/外部类型别名(ThinkingLevel/Transport)经 checker 解析成 enum + enumValues。
 */
function parseSettingsInterfaces(dtsPath: string): SchemaField[] {
  const program = ts.createProgram([dtsPath], {
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    skipLibCheck: true,
    noEmit: true,
  });
  const checker = program.getTypeChecker();
  const sf = program.getSourceFile(dtsPath);
  if (!sf) return [];

  const settingsDecl = sf.statements.find(
    (s): s is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(s) && s.name.text === "Settings",
  );
  if (!settingsDecl) return [];

  const out: SchemaField[] = [];
  const seen = new Set<string>();

  const walk = (decl: ts.InterfaceDeclaration, prefix: string): void => {
    for (const member of decl.members) {
      if (!ts.isPropertySignature(member) || !member.name || !member.type) continue;
      const name = member.name.getText(sf).replace(/^["']|["']$/g, "");
      const key = prefix ? `${prefix}.${name}` : name;
      const type = checker.getTypeFromTypeNode(member.type);
      for (const f of schemaFieldsOf(checker, key, type)) {
        if (seen.has(f.key)) continue;
        seen.add(f.key);
        out.push(f);
      }
    }
  };

  walk(settingsDecl, "");
  return out;
}

/** 把一个 TS Type 映射成 0..N 个 SchemaField(嵌套对象展平成多个 dotted 字段)。 */
function schemaFieldsOf(checker: ts.TypeChecker, key: string, type: ts.Type): SchemaField[] {
  const flags = type.flags;

  if (flags & ts.TypeFlags.Boolean) return [{ key, type: "boolean" }];
  if (flags & ts.TypeFlags.Number) return [{ key, type: "number" }];
  if (flags & ts.TypeFlags.String) return [{ key, type: "string" }];

  if (checker.isArrayType(type)) {
    const elem = checker.getTypeArguments(type as ts.TypeReference)[0];
    if (elem && (elem.flags & ts.TypeFlags.String)) return [{ key, type: "string[]" }];
    return [{ key, type: "object" }]; // 复杂数组(PackageSource[] 等)→ object
  }

  // 联合:全字符串字面量 → enum;全数字字面量 → number;否则 object
  if (type.isUnion()) {
    const strValues: string[] = [];
    let allStringLiteral = true;
    let allNumberLiteral = true;
    for (const t of type.types) {
      if (t.flags & ts.TypeFlags.StringLiteral) {
        strValues.push((t as ts.StringLiteralType).value);
        allNumberLiteral = false;
      } else if (t.flags & ts.TypeFlags.NumberLiteral) {
        allStringLiteral = false;
      } else {
        allStringLiteral = false;
        allNumberLiteral = false;
      }
    }
    if (allStringLiteral) return [{ key, type: "enum", enumValues: strValues }];
    if (allNumberLiteral) return [{ key, type: "number" }];
    return [{ key, type: "object" }];
  }

  if (flags & ts.TypeFlags.StringLiteral) {
    return [{ key, type: "enum", enumValues: [(type as ts.StringLiteralType).value] }];
  }

  // 对象:有属性就展平成 dotted 子字段(嵌套 interface / type literal);否则 object(不透明)
  const props = type.getProperties();
  if (props.length > 0) {
    const out: SchemaField[] = [];
    for (const p of props) {
      const pt = checker.getTypeOfSymbol(p);
      out.push(...schemaFieldsOf(checker, `${key}.${p.getName()}`, pt));
    }
    return out;
  }

  return [{ key, type: "object" }];
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

  /** 全量替换写入:整份 settings.json = obj(删除字段随之消失)。配置表单保存用——
   *  表单持有全量快照(get 后整份回传),deep merge 会保留已删字段,replace 才传播删除。 */
  async replace(obj: PiSettings): Promise<void> {
    const file = this.filePath;
    if (!existsSync(this.agentDir)) mkdirSync(this.agentDir, { recursive: true });
    await withDirLock(this.agentDir, async () => {
      await writeFile(file, JSON.stringify(obj, null, 2), "utf-8");
    });
  }
}
