// 模型探测（发现 + ping）的中性契约。
//
// 语义：对一个 OpenAI 兼容端点（baseUrl + apiKey）做两件纯 HTTP 的事——
//   discover：GET {baseUrl}/models 列出该端点下的全部模型 id；
//   ping：POST {baseUrl}/chat/completions 发一条最小请求，测往返时间。
// 内核无关：不起内核进程、不读任何内核配置，输入全部由调用方显式给出。
// 非 OpenAI 兼容的 api 类型（anthropic-messages / google-genai）由实现侧显式
// 降级（ok:false + 错误原因），不静默、不伪造成功。
//
// 消费方：设置页模型列表的「从 Base URL 发现」区块（ModelConfigPage 共享 base）。

/** 探测输入：端点连接事实。api 缺省按 openai-completions 处理。 */
export interface ModelProbeInput {
  baseUrl: string;
  apiKey?: string;
  api?: string;
}

/** 单次 ping 结果：ok 即通，latencyMs 为请求往返耗时；via = 命中的协议形状 id；不通带错误原因。 */
export interface ModelProbeResult {
  ok: boolean;
  latencyMs?: number;
  via?: string;
  error?: string;
}

/** 发现结果：models 为模型 id 清单（已按 id 排序）。via = 命中的发现策略 id（诊断用）。 */
export interface ModelDiscoverResult {
  ok: boolean;
  models?: string[];
  via?: string;
  error?: string;
}

/** 模型探测能力面（核心默认，零权限：用的是用户自己配置的 baseUrl/key）。 */
export interface ModelProbeApi {
  discover(input: ModelProbeInput): Promise<ModelDiscoverResult>;
  ping(input: ModelProbeInput & { model: string }): Promise<ModelProbeResult>;
}
