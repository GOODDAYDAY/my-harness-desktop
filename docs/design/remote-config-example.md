# remote.json 配置示例

远程访问配置落在数据根 `~/.my-harness-desktop/config/remote.json`（dev 态 `~/.my-harness-desktop-dev/config/remote.json`）。密码以 scrypt hash 存，不落明文。文档主线的 §37.1 有结构，这里给一份带具体值的完整示例 + 逐字段说明。

## 完整示例

```jsonc
{
  // 远程访问总开关:false 只绑 127.0.0.1(本机),true 才按 bind 绑网卡。
  "enabled": false,

  // 网络绑定:loopback = 127.0.0.1(只本机),lan = 0.0.0.0(局域网/公网可达)。
  // remote:start 会把它写为 lan;重绑定需后端重启生效(§8.6)。
  "bind": "loopback",

  // 监听端口,固定默认 4763;被占时自适应后写回实际值。
  "port": 4763,

  "lan": {
    // 局域网密码开关:默认开,可 remote:setLanPasswordEnabled 关。
    "enabled": true,

    // 密码 hash,格式 scrypt$<salt hex>$<hash hex>。null = 未设(局域网开启但没密码)。
    // 例(不是真实 12345678 的 hash,仅示意格式):"scrypt$1a2b3c...$d4e5f6..."
    "passwordHash": null,

    // 是否用户自定义:true = 用户 remote:setPassword 固定,不再被 refreshPassword 换新。
    "customized": false
  },

  "public": {
    // 公网密码 hash。每次 remote:tunnelStart 成功自动换新;自定义固定后 customized=true。
    "passwordHash": null,

    "customized": false,

    // 上次隧道 URL(恢复用):后端重启时据此自动重拉隧道,沿用上次密码。
    "activeTunnel": null
  }
}
```

## 开启局域网访问后的示例

```jsonc
{
  "enabled": true,
  "bind": "lan",
  "port": 4763,
  "lan": {
    "enabled": true,
    "passwordHash": "scrypt$9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08$60303ae22b998861bce3b28f33eec1be758a213c86c93c0769bea32c9bd3d4b6",
    "customized": false
  },
  "public": {
    "passwordHash": null,
    "customized": false,
    "activeTunnel": null
  }
}
```

## 字段速查

| 字段 | 类型 | 默认 | 含义 |
|---|---|---|---|
| `enabled` | boolean | `false` | 远程访问总开关 |
| `bind` | `"loopback" \| "lan"` | `"loopback"` | 网络绑定;`lan` = 0.0.0.0 |
| `port` | number | `4763` | 监听端口 |
| `lan.enabled` | boolean | `true` | 局域网密码开关 |
| `lan.passwordHash` | string \| null | `null` | 局域网密码 hash（scrypt$salt$hash） |
| `lan.customized` | boolean | `false` | 是否自定义固定（不再自动换） |
| `public.passwordHash` | string \| null | `null` | 公网密码 hash |
| `public.customized` | boolean | `false` | 是否自定义固定 |
| `public.activeTunnel` | string \| null | `null` | 上次隧道 URL（恢复用） |

## 注意

- **密码不落明文**：`passwordHash` 是 scrypt hash（`core/application/remote/password.ts` 的 `hashPassword`）。改密码走设置页的 `remote:setPassword` / `remote:refreshPassword`，不手写这个字段。
- **改 bind 要重启**：`remote:start`/`remote:stop` 只写配置，实际重绑定（0.0.0.0 ↔ 127.0.0.1）在后端下次启动时生效。
- **token 不在此文件**：登录后签发的 HMAC token 由后端 `serverSecret`（每次启动随机）派生，重启即失效，不落盘。
