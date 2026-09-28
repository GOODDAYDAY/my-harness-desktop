// dsh 原生配置契约 —— provider CRUD + 默认模型 + settings + cordis 插件块。
//
// **为什么住在 dsh 自己的目录里，而不是圆心**（根因，勿回退）：
// 这四个类型此前声明在 `packages/shared/src/domain/context.ts`，即**圆心里定义了 dsh 专属形状**。
// 实测它们的真实消费者**全部在 `src/server/kernel/dsh/` 内部**（`dsh-config-source` 实现它、
// `dsh-extension-installer` / `dsh-kernel-api` / `dsh-kernel-config` 消费它），壳侧三处 import
// （`controllers/kernel.ts`、`web/kernel/build-kernel.ts`、`packages/react/src/index.ts`）
// 经核实**全是死 import**（只 import、零使用、也未 re-export）。
//
// 于是圆心承担了它不该承担的东西：`addPluginBlock`（cordis 插件块）、`~/.dsh/.credentials.yaml`
// 的密钥语义、`reasoningEfforts` 档位映射，都是 dsh 的私有知识。按 CLAUDE.md §1.1「依赖只向内」
// 与 §4.2「圆心 = 拿掉所有会变的东西之后还剩什么」，换掉 dsh 这些类型就该消失——它们不是圆心。
//
// 壳要驱动内核配置，走的是**中性** `KernelConfigApi`（`get`/`set`/`fields()`，圆心定义、
// 三个内核各自实现：`createDshConfigApi` / `createPiConfigApi` / `MinimalConfigApi`）；
// dsh 的 provider CRUD 由 **dsh 自己的内核插件**（`src/plugins/kernels/dsh/renderer/models.tsx`）
// 经该中性面驱动，不需要壳认识 `DshProvider`。
//
// 依赖方向：本文件零 import（纯类型），只被同内核的文件引用。

/** dsh 模型单条（dsh 侧模型字段：id/name/contextWindow/maxTokens + reasoning）。
 *  对齐官方 dsh-llm-pi-ai 的 `PiAiModelProfile` 公共子集。
 *  `reasoning=true` 在写回 settings.yaml 时展开成 reasoningEfforts 档位映射
 *  （dsh 侧的推理能力声明形状；docs/design/dsh-thinking-level.md §5）。 */
export interface DshModelSpec {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  /** 推理能力标记（读回时由 reasoningEfforts 存在性反推）。 */
  reasoning?: boolean;
}

/** dsh 一个 provider 路由 + 连接事实（apiKey/displayName/api/baseURL）+ 模型列表。
 *  对齐官方 dsh-llm-pi-ai 的 `PiAiProviderProfile` 公共子集。apiKey 是密钥字面值——
 *  由桌面端输入，经 `DshConfigSource` 写入 dsh 的凭证库（`~/.dsh/.credentials.yaml`）供 dsh 解析，
 *  不再经进程环境变量注入。 */
export interface DshProvider {
  provider: string;
  /** 密钥字面值（凭证库读回；不落 settings.yaml）。 */
  apiKey?: string;
  /** 配置面显示名，缺省 = provider route key。 */
  displayName?: string;
  api?: string;
  baseURL?: string;
  models: DshModelSpec[];
}

/** dsh 默认模型选择（agent-default-model 命名空间）。 */
export interface DshDefaultModel {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

/** dsh 原生配置管理面。`DshConfigSource` 实现；消费者全在 dsh 内核目录内。
 *  壳侧不 import 本接口——壳只认中性 `KernelConfigApi`（见 `dsh-kernel-config.ts` 的翻译）。 */
export interface DshConfigApi {
  listProviders(): DshProvider[];
  setProvider(provider: string, detail: Omit<DshProvider, "provider">): Promise<void>;
  renameProvider(oldId: string, newId: string): Promise<void>;
  removeProvider(provider: string): Promise<void>;
  getDefaultModel(): DshDefaultModel | null;
  setDefaultModel(sel: DshDefaultModel): Promise<void>;
  /** 清掉 agent-default-model 指针（删除 default provider 时调用，避免悬空指向已删路由）。 */
  clearDefaultModel(): Promise<void>;
  getSettings(): Record<string, unknown>;
  setSettings(obj: Record<string, unknown>): Promise<void>;
  /** cordis 插件块管理（dsh 扩展安装器同步壳插件携带的 dsh 扩展用）。 */
  addPluginBlock(id: string, name: string): void;
  removePluginBlock(id: string): void;
}
