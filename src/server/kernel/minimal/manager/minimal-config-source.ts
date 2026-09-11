// minimal 私有存储的读写面 —— 模型配置(models.json)+ 凭证(.credentials.json)+ 原生配置(config.json)。
//
// 依据 docs/design/minimal-kernel.md §4.9.1（配置与凭证分开存）/ §4.9.2（apiKey 完整生命周期）/
// §3.2.3（原子写：写临时文件 + rename）。这是 minimal 侧的「适配器私有知识」落点：
// 壳的 application 层（session-store / controllers）不知道也不碰这三个路径，路径经工厂闭包注入。
//
// 为什么单独成文件、而不是留在 minimal-models.ts 里拼路径:
// 1) 「写配置」与「读配置」是两件事，且**每份文件只有一个写入者**。此前写入面是空实现
//    （set/remove/rename/setDefault/saveConfig 返空数组、set 回显入参），设置页点保存看着成功、
//    实际什么都没落盘——正是 §7.9.3 明令禁止的「伪造成功」。把读写收成一份 source，
//    读取面（MinimalModelSource）与写入面（MinimalModelsApi）共用同一份解析/序列化，
//    杜绝「读的是一个格式、写的是另一个格式」的漂移。
// 2) 原子写需要一个统一的写入口。此前 setModel/setSessionName/setTools 每次都整文件重写、
//    且无 temp+rename，写一半被 kill 就留半截 JSON（§3.2.3 要求「要么完整旧态、要么完整新态」）。
//    所有写入经 writeJsonAtomic 走同一条路径，原子性只需在一处守住。
// 3) 凭证分离需要一个知道「哪份文件装密钥」的地方。models.json 里不落明文 apiKey，
//    密钥落 .credentials.json；writeProvider 在写配置时顺手把 legacy 明文迁走（迁移只做一次、幂等）。

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { NeutralDefaultModel, NeutralProvider } from "@my-harness-desktop/shared";

/** models.json 里一条 provider 记录（**不含 apiKey** —— 密钥在凭证文件里）。 */
export interface MinimalProviderRecord {
  id: string;
  baseURL: string;
  models: { id: string; name?: string }[];
}

/** models.json 的整份形状（minimal 自己的格式：providers + default）。 */
export interface MinimalModelsDocument {
  providers: MinimalProviderRecord[];
  default: NeutralDefaultModel | null;
}

/** minimal 的模型/凭证/原生配置读写。三个路径都在 agentDir 下（minimal 自己的数据根）。 */
export class MinimalConfigSource {
  readonly modelsPath: string;
  readonly credentialsPath: string;
  readonly configPath: string;

  constructor(private readonly agentDir: string) {
    this.modelsPath = join(agentDir, "models.json");
    this.credentialsPath = join(agentDir, ".credentials.json");
    this.configPath = join(agentDir, "config.json");
  }

  // ---- 模型配置（models.json）----

  /** 读整份模型配置。文件缺失/损坏 → 空文档（读不回不致命；写路径单独报错，不静默吞写失败）。 */
  readModels(): MinimalModelsDocument {
    const raw = readJson(this.modelsPath);
    const providers = Array.isArray(raw?.["providers"]) ? (raw["providers"] as unknown[]) : [];
    return {
      providers: providers.flatMap((p) => {
        const rec = p as Record<string, unknown>;
        if (typeof rec?.["id"] !== "string") return [];
        const models = Array.isArray(rec["models"]) ? (rec["models"] as unknown[]) : [];
        return [{
          id: rec["id"],
          baseURL: typeof rec["baseURL"] === "string" ? rec["baseURL"] : "",
          models: models.flatMap((m) => {
            const mm = m as Record<string, unknown>;
            if (typeof mm?.["id"] !== "string") return [];
            return [{ id: mm["id"], ...(typeof mm["name"] === "string" ? { name: mm["name"] } : {}) }];
          }),
        }];
      }),
      default: readDefault(raw?.["default"]),
    };
  }

  /** 中性形状（设置页模型 TAB 用）：provider 记录 + 各自的 apiKey（从凭证文件读）。 */
  listProviders(): NeutralProvider[] {
    return this.readModels().providers.map((p) => ({
      id: p.id,
      baseUrl: p.baseURL,
      apiKey: this.readApiKey(p.id),
      models: p.models.map((m) => ({ id: m.id, name: m.name ?? m.id })),
    }));
  }

  /** 新增/覆盖一个 provider。apiKey 不落 models.json —— 写凭证文件（空串 = 删除该密钥）。 */
  setProvider(id: string, detail: Omit<NeutralProvider, "id">): void {
    const doc = this.readModels();
    const next: MinimalProviderRecord = {
      id,
      baseURL: detail.baseUrl ?? "",
      models: detail.models.map((m) => ({ id: m.id, ...(m.name && m.name !== m.id ? { name: m.name } : {}) })),
    };
    const idx = doc.providers.findIndex((p) => p.id === id);
    if (idx >= 0) doc.providers[idx] = next;
    else doc.providers.push(next);
    this.writeModels(doc);
    if (typeof detail.apiKey === "string") this.writeApiKey(id, detail.apiKey);
  }

  /** 删除 provider：连带清掉它的凭证与「默认指向它」的悬空指针（否则 default 指向已删路由）。 */
  removeProvider(id: string): void {
    const doc = this.readModels();
    doc.providers = doc.providers.filter((p) => p.id !== id);
    if (doc.default?.provider === id) doc.default = null;
    this.writeModels(doc);
    // 凭证文件里不留已删 provider 的密钥（delete refs：写空串即删除）。
    this.writeApiKey(id, "");
  }

  /** 改名：迁移 provider 记录、default 指针、凭证 ref 三处，缺一处就留下孤儿。 */
  renameProvider(oldId: string, newId: string): void {
    if (oldId === newId) return;
    const doc = this.readModels();
    const target = doc.providers.find((p) => p.id === oldId);
    if (!target) return;
    if (doc.providers.some((p) => p.id === newId)) {
      throw new Error(`provider 已存在: ${newId}`);
    }
    target.id = newId;
    if (doc.default?.provider === oldId) doc.default = { ...doc.default, provider: newId };
    this.writeModels(doc);
    const key = this.readApiKey(oldId);
    if (key) {
      this.writeApiKey(newId, key);
      this.writeApiKey(oldId, "");
    }
  }

  getDefaultModel(): NeutralDefaultModel | null {
    return this.readModels().default;
  }

  setDefaultModel(sel: NeutralDefaultModel): void {
    const doc = this.readModels();
    doc.default = sel;
    this.writeModels(doc);
  }

  /** 清掉默认模型指针（删除 default provider / 清空选择时调用，否则残留悬空引用）。 */
  clearDefaultModel(): void {
    const doc = this.readModels();
    doc.default = null;
    this.writeModels(doc);
  }

  private writeModels(doc: MinimalModelsDocument): void {
    writeJsonAtomic(this.modelsPath, {
      providers: doc.providers.map((p) => ({
        id: p.id,
        baseURL: p.baseURL,
        models: p.models.map((m) => (m.name && m.name !== m.id ? { id: m.id, name: m.name } : { id: m.id })),
      })),
      ...(doc.default ? { default: doc.default } : {}),
    });
  }

  // ---- 凭证（.credentials.json，§4.9.1/§4.9.2）----

  /** 读某 provider 的 apiKey 字面值；未配置返回空串。 */
  readApiKey(provider: string): string {
    const raw = readJson(this.credentialsPath);
    const v = raw?.[provider];
    return typeof v === "string" ? v : "";
  }

  /** 写某 provider 的 apiKey（空串 = 删除该条）。文件权限收到 0600（密钥不该是世界可读）。 */
  writeApiKey(provider: string, key: string): void {
    const raw = readJson(this.credentialsPath) ?? {};
    if (key === "") delete raw[provider];
    else raw[provider] = key;
    writeJsonAtomic(this.credentialsPath, raw, 0o600);
  }

  /**
   * 一次性迁移：把 legacy 明文 apiKey 从 models.json 搬进凭证文件（§4.9.1「配置文件里不留明文」）。
   * 幂等：搬完 models.json 里就没有 apiKey 字段了，再跑是空操作。
   * 为什么需要它：写入面此前是空实现，用户只能手改 models.json 写明文 apiKey 才用得上模型——
   * 这批历史数据不迁走，「配置与凭证分离」就只是对以后成立的规矩。
   */
  migratePlaintextApiKeys(): boolean {
    const raw = readJson(this.modelsPath);
    const providers = Array.isArray(raw?.["providers"]) ? (raw["providers"] as unknown[]) : [];
    let changed = false;
    for (const p of providers) {
      const rec = p as Record<string, unknown>;
      if (typeof rec?.["apiKey"] !== "string" || !rec["apiKey"]) continue;
      if (typeof rec["id"] === "string" && !this.readApiKey(rec["id"])) {
        this.writeApiKey(rec["id"], rec["apiKey"]);
      }
      delete rec["apiKey"];
      changed = true;
    }
    if (changed) this.writeModels(this.readModels());
    return changed;
  }

  // ---- 原生配置（config.json，§7.9 内核配置 TAB）----

  /** 读 minimal 的原生配置（当前无内置字段，但存储是真的：写进去的键读得回来）。 */
  readConfig(): Record<string, unknown> {
    return readJson(this.configPath) ?? {};
  }

  /** 写整份原生配置（原子写，读回一致）。 */
  writeConfig(obj: Record<string, unknown>): Record<string, unknown> {
    writeJsonAtomic(this.configPath, obj);
    return this.readConfig();
  }
}

/** 读一份 JSON 对象；文件缺失/损坏/非对象 → null（调用方决定回落语义）。 */
function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/**
 * 原子写 JSON（§3.2.3）：写同目录临时文件 → fsync 语义由 rename 保证可见性切换 → rename。
 * 崩溃/被 kill 在写一半时，目标路径要么还是完整的旧内容、要么是完整的新内容，
 * 不会出现半截 JSON（此前是 writeFileSync 原地截断写，半截文件真实可复现）。
 * 临时名带 pid，避免同目录并发写互相覆盖临时文件。
 */
function writeJsonAtomic(path: string, value: unknown, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, mode === undefined ? "utf-8" : { encoding: "utf-8", mode });
    renameSync(tmp, path);
  } catch (e) {
    // 写失败不留临时文件残骸（rename 成功时 tmp 已不存在，rmSync 是兜底）。
    try { rmSync(tmp, { force: true }); } catch { /* 清理失败不掩盖原始错误 */ }
    throw e;
  }
}

/** 解析 default 指针（形状非法 → null，不把垃圾值当默认模型用）。 */
function readDefault(v: unknown): NeutralDefaultModel | null {
  if (!v || typeof v !== "object") return null;
  const d = v as Record<string, unknown>;
  if (typeof d["provider"] !== "string" || typeof d["model"] !== "string") return null;
  return { provider: d["provider"], model: d["model"] };
}
