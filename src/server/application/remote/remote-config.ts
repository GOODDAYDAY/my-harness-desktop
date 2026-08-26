// 远程访问配置(web-service §37.1)——remote.json 的读/写。依赖只向内:JSON 原语。
// 密码以 hash 存(passhash),不存明文;bind loopback=只本机、lan=0.0.0.0。

import { readJsonFile, writeJsonFile } from "../config/config-file";

/** 远程访问配置(§37.1)。 */
export interface RemoteConfig {
  /** 远程访问总开关。 */
  enabled: boolean;
  /** 网络绑定:loopback(127.0.0.1) | lan(0.0.0.0)。 */
  bind: "loopback" | "lan";
  /** 监听端口(固定默认,被占自适应后写回实际值)。 */
  port: number;
  lan: {
    /** 局域网密码开关。 */
    enabled: boolean;
    /** 密码 hash(scrypt$...)。未设 = null。 */
    passwordHash: string | null;
    /** 是否用户自定义(自定义后不再自动换)。 */
    customized: boolean;
  };
  public: {
    passwordHash: string | null;
    customized: boolean;
    /** 上次隧道 URL(恢复用)。 */
    activeTunnel: string | null;
  };
}

export const DEFAULT_REMOTE_CONFIG: RemoteConfig = {
  enabled: false,
  bind: "loopback",
  port: 4763,
  lan: { enabled: true, passwordHash: null, customized: false },
  public: { passwordHash: null, customized: false, activeTunnel: null },
};

/** remote.json 的读/写。defaults 兜底缺省层,深层字段( lan/public )逐层合并。 */
export class RemoteConfigStore {
  private data: RemoteConfig;

  constructor(private readonly path: string) {
    const raw = readJsonFile(path) as Partial<RemoteConfig>;
    this.data = {
      ...DEFAULT_REMOTE_CONFIG,
      ...raw,
      lan: { ...DEFAULT_REMOTE_CONFIG.lan, ...(raw.lan ?? {}) },
      public: { ...DEFAULT_REMOTE_CONFIG.public, ...(raw.public ?? {}) },
    };
  }

  get(): RemoteConfig {
    return this.data;
  }

  async update(patch: Partial<RemoteConfig>): Promise<RemoteConfig> {
    this.data = { ...this.data, ...patch };
    await writeJsonFile(this.path, this.data as unknown as Record<string, unknown>);
    return this.data;
  }
}
