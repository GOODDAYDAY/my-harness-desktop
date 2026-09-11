# 中立存储拆分 + 增量广播:归档从「整树读写 + 全端全量重扫」到「定点小写 + 本地打补丁」

> 2026-08 立项。问题:归档一个布尔位,实测(用户真实数据:N=1089 会话,中立层 308MB,pi 侧 259MB)
> 走成「2 次整文件读 + 2 次整文件写 + 广播后每端 1.75s 全目录全量 parse」;批量归档 50 个
> → 50 次广播 → 每端 ≈87s 纯解析。本文是修复设计,落地三刀 + 一顺手刀。

## 1. 病灶(实测钉死的数字)

归档 = 改会话头里 `archived` 一个布尔位,链路却处处按「整棵会话树」付费:

| 热点 | 位置 | 实测(真实数据) |
|---|---|---|
| 列表重拉全目录整树 parse | `NeutralSessionStore.listByCwd` | 1089 文件 ≈ **1750ms/次/端** |
| 中立层整树读+写(改一个布尔) | `writeNeutralHeader → get/put` | 中位 83KB 会话 ≈6ms,8MB 会话 ≈70ms |
| pi 投影整文件读+重写 | `piUpdateSessionHeader` | 与上同量级,且**读路径已不消费它**(冗余写) |
| 广播引发多端重扫 | `headerChanged → loadForCwd` | ×(K 次归档 × 客户端数) 乘法放大 |

乘法项(重扫)是主犯,加法项(双写)次之。根因是三个「读写对象错配」:

1. **header 与 entries 焊在一个文件**:中立层只有整读整写两个原语,改 header 必须搬运整树。
2. **列表只要 header 却 parse 整树**:`listByCwd` 读全部 308MB 只为取每棵树的 header(几 KB)。
3. **广播只当「重拉哨子」**:payload 里本来就带着 `sessionPath + patch`,客户端完全能本地打补丁,却全量重拉。

## 2. 设计

### 2.1 存储拆分:header 与 entries 分文件

```
<数据根>/sessions/
  <ns>.header.json    —— { neutralSessionId, rootLineageId, header }   (几 KB,列表/写头只碰它)
  <ns>.entries.json   —— { neutralSessionId, lineages(含 entries) }   (大,打开会话才读)
  <ns>.json           —— 遗留整树文件(拆分前),读到即懒迁移,迁移后删除
```

- **为什么拆两个文件而不是 JSONL 追加**:entries 有原地改写语义(backfillUserAuthority 回填 id、
  reprojectEntries 重投影),append-only 要引入墓碑/压实,复杂度不成比例。拆文件已经把
  「改 header」和「列列表」两条热路径降到 O(header),entries 全量重写维持现状(与今天相同,
  只发生在真实内容变更时,那是无法避免的)。
- **`rootLineageId` 必须进 header 文件**:clone/seed 会话的根 lineageId ≠ ns(派生保留源
  lineageId),列表投影地址按根 lineageId 派生,不能只凭 ns 猜。空会话(尚无 lineage)回退 ns,
  与 `neutralToSessionInfo` 现行 `?? ns` 语义一致。
- **写序**:entries 先于 header。header 的列表行字段可从 entries 派生自愈
  (`derivedHeaderFromSession`),写一半崩了最坏是 header 陈旧,内容不丢。
- **顺手刀:去美化缩进**。`JSON.stringify(session, null, 2)` → 紧凑。实测 8MB 会话文件
  美化态 7.7MB,紧凑后更省;parse/stringify 双快。

### 2.2 懒迁移:读到旧格式就拆

`get / getHeader / listByCwd` 遇到 `<ns>.json` 遗留文件:读整树 → **顺手 heal**(`derivedHeaderFromSession`
补齐 pre-阶段-D 头缺的 lastMessage/lastEntryId/updatedAt——迁移是唯一能免费拿整树的时刻,
愈合落盘,列表从此不需要读时兜底)→ 写两个新文件 → 删旧文件。

首次列表会一次性迁移全部存量(用户数据 ≈1.75s 一次性成本),之后每次列表只读 header 文件。

`put` 也顺手删同 ns 的遗留文件(防旧文件在后续迁移判定里诈尸)。

### 2.3 列表读路径:摘要替代整树

`listByCwd(cwd)` 改返回 **`NeutralSessionSummary[]`**(`{ neutralSessionId, rootLineageId, header }`,
类型在圆心 `session-neutral.ts`),不再返回整树。生产调用方唯一(`SessionStore.list`),
映射 SessionInfo 不再需要 entries(字段全靠迁移时 heal 进 header)。签名收窄是刻意的:
让「列表想拿 entries」在类型层就写不出来。

### 2.4 写头路径:只写 header 文件

`SessionStore` 内纯头变更三处全部从「整树 get + 整树 put」改为「`getHeader` + `putHeader`」:

- `writeNeutralHeader`(归档/置顶/改名/custom)
- `writeNeutralModelPrefs`(模型域落盘——发消息高频路径,顺带受益)
- `clearPendingSeed`

`putNeutral`(条目变更)维持整树写,但落盘拆成 entries + header 两文件。

### 2.5 内核投影:{pinned, archived} 纯补丁跳过内核写

查证(2026-08,落地前核实):

- pi 头行 `pinned/archived` **零读者**——`piReadSessionHeader` 的内部消费者只有
  `piReadSessionCustom → piReadSessionToolConfig`(只读 toolConfig);列表/打开都读中立层;
  兜底重建(`snapshotNeutralSession`)今天就不从内核恢复 pinned/archived。
- 一次性迁移（当时的 `importLegacyPiSessions`，现为内核自报的 `readLegacySessions()` + 壳侧 `importLegacySessions`）读存量旧文件的 pinned/archived——读的是**过去**投影写下的
  值,今后不再投影不影响存量;且该路径本就有「中立层已存在则跳过」的幂等守卫。
- `name` 投影保留(pi `session_info` 条目是名字的内核侧真相源,有消费者);
  `toolConfig`/`custom` 投影保留(tool-gate 内核扩展在 pi 进程内读头行 toolConfig,真实消费者)。

所以:`projectHeaderToKernel` 里,name 照投;其余键若 ⊆ {pinned, archived} → **跳过内核写**。
dsh 同理(其 updateHeader RPC 只接 pinned/archived/custom——同样无内核侧消费者,同样跳过)。

### 2.6 增量广播:headerChanged 带补丁,客户端本地打行

- payload 类型化为圆心 `SessionHeaderChangedEvent`(判别联合:updateHeader / rename / delete / copy)。
- web store 新增两个动作:`applyHeaderPatch(sessionPath, patch)`(就地改 sessionInfos 里那一行,
  path 与 ns 双键同改)、`removeSessionRows(paths)`(连 ns 别名键一起摘)。
- `onHeaderChanged` 路由:updateHeader/rename → applyHeaderPatch;delete → removeSessionRows;
  **copy → 仍全量重拉**(新会话本地无行可补丁,复制是罕见操作,不值当造本地行)。
- 插件侧(`sessions-list`)写成功后直接调 store 动作打本地补丁,不等广播(广播到达是幂等双写);
  **失败路径才全量重拉**回滚真相。乐观摘行的清理时机不变(本地补丁完成后)。

乘法项就此拆除:归档从「每端全目录重扫」变「每端改一行」。

## 3. 不变量与边界

- **中立层仍是唯一真相源**,拆分不改这条;内核存储仍是投影(且 pinned/archived 连投影都省了)。
- **崩溃一致性**:put 先 entries 后 header;两半不一致时以 entries 为内容真相,header 可重建。
- **归档丢失边界(显式接受)**:中立文件被删/损坏 + 内核文件仍在 → 兜底重建/重迁移读不回
  archived(今天 snapshotNeutralSession 就如此)。pinned/archived 是 desktop 展示态,丢失无内容损失。
- **`filePathOf`(「打开 desktop 原始文件」)**:返回 entries 文件(内容主体);未迁移的遗留文件仍返回
  旧路径。调用方 `existsSync` 判定不变。
- **header 文件形状守卫**与整树同级:坏 JSON/坏形状跳过 + 记日志,不拖垮列表(r370 纪律延续)。

## 4. 验收

- 单测:拆分读写回环、迁移(含 heal)、删除三文件变体、putHeader 不动 entries、
  listByCwd 摘要形状;web store 补丁动作(双键、ns 别名摘除)。
- 既有套件:`session-store.test.ts` 归档/置顶组、`neutral-session-store.test.ts` 改写。
- benchmark(真实数据副本):列表重拉 1750ms → 目标 <50ms;单会话归档写 ~6-70ms → 亚毫秒级 header 写。
- 运行时证据:起 app 实测归档/批量归档/置顶/改名/删除多端联动。
