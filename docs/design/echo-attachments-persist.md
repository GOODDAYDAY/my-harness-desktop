# echo 徽章持久化设计

review 插件让用户选中会话流里的片段写评论，评论随下一次发送一次性交给模型；发出后那条用户气泡下方挂一排只读徽章（编号 + ❝引文快照 + 意见，机制见 `review-plugin.md` §2.4 的 echo/send 双形态）。本文定义徽章的持久化：**展示是文件内容的纯函数**——切会话、刷新、重启，显示形态与发送瞬间一致。

## 1. 机制：一个标识 + 对比删除

```
写(发送瞬间,一步):
  sendMessage 算出 sendText(实发全文) → hash(sendText) → { items } 写头行 custom 域

读(任何重建路径,一步):
  每条 user 消息: hash(textOf(content)) 查头行 → 命中挂徽章

展示(渲染层,一步):
  徽章在场 → 从固定分隔符 "\n\n---\n" 对比删除拼装片段 → 气泡 = 干净正文
```

就这三步。写不依赖任何事件（不等底座回执、不等 id 水合、不依赖底座补丁）；读是纯查表；展示删除只定位固定分隔符，不是反解析用户可配的拼装格式。

### 1.1 为什么键是 hash(实发全文)

文件里 user 消息的 content 恒等于实发全文——hash 在发送瞬间与任何重建路径（重扫 JSONL / RPC 重放）天然对齐，不需要任何中间事件把"发送时的消息"和"文件里的条目"对上。

- **撞键语义正确**：同 sendText = 同正文 + 同评论（片段含评论内容）= 同展示。重试/复制重发的那条本来就该显示同样的徽章。
- **否掉 entryId 键（历史方案，已退役）**：发送瞬间拿不到 entryId，必须等底座落盘事件 → 链条依赖底座补丁发射 `entry_appended`、id 水合命中、按 id 反查——任一环断裂静默不写。实证：该链条在真实运行态一次都没写成功过，"切回来徽章没了"的直接原因。
- **hash 不占预算**：8 位十六进制，不存全文。

### 1.2 为什么正文不用落盘：对比删除

重扫后 content 是发给模型的合并全文（正文 + 拼装片段）。拼装片段是 review 自己拼的：`composePromptFragment` 里分隔符 `"\n\n---\n"` 硬编码，用户可配的只有 header 文案与条目模板——**删除只需定位固定分隔符，不需要逆着用户模板反解**。徽章在场是唯一闸门：无徽章的消息里用户手打的 `---` 不受影响。

删除发生在渲染层（timeline blocks.ts 的 userText 分解），与既有的工具限制前缀剥除（`stripToolLimitNote`）同源同位——content 始终保持文件真相全文，展示 = content − 已知注入物。fork/书签/复制走文件与底座，不经渲染层剥除，拿到永远是完整真相。

### 1.3 新会话首发：pending 桶

发送瞬间会话文件可能尚未创建（新会话第一条消息），头行无处可写。按 cwd 暂存进 pending 桶，`sessionStart` 事件带回权威文件路径时一次刷入。sessionStart 是 main 侧自发的合成事件（不经底座），是这条链路上唯一的事件依赖，且只影响新会话首发一条路径。

## 2. 存哪：头行 custom 域（既有机制零改动）

会话 JSONL 头行 `custom-pi-desktop.echoAttachments`，值形 `{ [hash(sendText)]: EchoAttachment[] }`。写读链路复用头行机制既有设施（`session-header-custom.md`）：`updateHeader` 域级浅合并、`withDirLock` 目录锁、`readSession` 透传 `SessionInfo.custom`。整域替换语义要求调用方持全量镜像写入——renderer 侧 `echoMirrorBySession` 是装配场，真相源在文件。

预算（与头行其他租户共享 8KB 热读预算，`session-header-custom.md` §2.4）：

- **条数闸**：最多 15 键，FIFO 淘汰最旧。
- **序列化闸**：`JSON.stringify ≤ 3072B`，超了继续淘汰（至少留一键）。
- **字段截断**：`quotePreview ≤ 60`、`comment ≤ 160`——徽章本就是预览。

超预算最旧的徽章风化（正文仍在）：徽章是展示层资产，正文是内容，丢失后果不同级。

## 3. 边界

- **正文含 `\n\n---\n`**：用户手打的 markdown 分隔线恰好在带评论的消息里 → 对比删除切在第一处，其后正文并入被删段。显示层尾部损耗，内容层（文件）无损。低概率，不做恢复。
- **崩溃**：发送后底座崩溃、prompt 未落盘 → 文件里没有这条消息，徽章键成孤儿，随 FIFO 代谢。本会话内存态徽章仍在（三道水合保着）。
- **legacy entryId 键数据**：历史版本按 entryId 落盘的条目，hash 查不到即不显示——不为错数据兜底，FIFO 预算自然代谢。

## QA

**Q：第三方插件发徽章能蹭上持久化吗？**
能。机制在框架层（`sendMessage` 的 `opts.echoAttachments` → 头行），review 只是第一个使用者。域名按 desktop 功能域命名而非插件 id。

**Q：两次 fire-and-forget 写会丢更新吗？**
不会。装配在 renderer 单线程同步完成；`updateHeader` 由 main 侧目录锁串行；每次写入携带全量镜像——后写包含先写的增量。

**Q：会话 fork/复制，徽章跟着走吗？**
跟。徽章在头行，头行是文件的一部分。删会话徽章一起没——会话级数据与会话同生共死（不选全局配置的判据，`session-header-custom.md` §1.1）。
