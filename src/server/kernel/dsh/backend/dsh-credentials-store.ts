// client/dsh —— dsh 凭证库(~/.dsh/.credentials.yaml)的最小读写面,供 DshConfigSource 存/取 API Key。
//
// 依据 dsh 官方 dsh-credentials-local 的 version-1 布局:
//   version: 1
//   refs:
//     PROVIDER_API_KEY: sk-xxx      # CredentialRef → 字面值
//   records: { ... }                 # 授权记录(桌面端不碰,读改写原样保留)
//
// dsh-llm-pi-ai 的 PiAiProviderProfile.apiKeyEnv 是一个 CredentialRef(环境变量名形状),
// 经 ctx.credentials 解析;凭证库是它优先于 .env 的「可写」层。桌面端把密钥字面值写进
// refs、并在 settings.yaml 的 route 上写 apiKeyEnv=<deriveKeyRef(provider)>,dsh 启动后从
// 凭证库读到密钥——全程不注入进程环境变量(用户要求「不要 env」)。
//
// deriveKeyRef 与 dsh 官方 settings-models UI 同款:provider 大写化、非字母数字转下划线、后缀 _API_KEY。
// 依赖只向内:只用 node 内建 + yaml(与 dsh-config-source 同源),零 import dsh 内核包。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parse, stringify } from "yaml";

/** provider route key → CredentialRef(与 dsh 官方 settings-models UI 的 deriveKeyRef 同款)。 */
export function deriveKeyRef(provider: string): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
}

interface CredentialsDocument {
  version?: number;
  refs?: Record<string, unknown>;
  [key: string]: unknown;
}

/** 读整份凭证库文档;文件缺失/损坏回空文档(读不回密钥不致命,写路径单独报错)。 */
function readDocument(credentialsPath: string): CredentialsDocument {
  if (!credentialsPath || !existsSync(credentialsPath)) return {};
  try {
    const parsed = parse(readFileSync(credentialsPath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as CredentialsDocument : {};
  } catch {
    return {};
  }
}

/** 读某 provider 的 API Key 字面值;未配置返回空串。 */
export function readApiKey(credentialsPath: string, provider: string): string {
  const ref = deriveKeyRef(provider);
  const doc = readDocument(credentialsPath);
  const value = doc.refs?.[ref];
  return typeof value === "string" ? value : "";
}

/** 写某 provider 的 API Key 字面值(空串 = 删除该 ref)。保留 records 与其它 refs。 */
export function writeApiKey(credentialsPath: string, provider: string, key: string): void {
  if (!credentialsPath) throw new Error("dsh 凭证库路径未配置");
  const ref = deriveKeyRef(provider);
  const doc = readDocument(credentialsPath);
  const refs = (doc.refs && typeof doc.refs === "object" && !Array.isArray(doc.refs))
    ? { ...doc.refs as Record<string, unknown> }
    : {};
  if (key === "") delete refs[ref];
  else refs[ref] = key;
  const next: CredentialsDocument = { version: 1, ...doc, refs };
  mkdirSync(dirname(credentialsPath), { recursive: true });
  writeFileSync(credentialsPath, stringify(next), "utf-8");
}
