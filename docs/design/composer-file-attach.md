# 输入框文件/图片附件(composer file & image attach)

## 目标

会话流输入框左下角 `+` 目前是占位(TBD)。补齐三类文件输入入口,并落到「AI 可参考」的语义:

1. **点 `+`** → 系统文件选择对话框,选文件或图片。
2. **拖拽文件进输入框** → 展示 + 输入。
3. **复制/粘贴文件进输入框** → 直接展示为**绝对路径**。
4. **只输入文件**(正文为空)也要能发送;「可用文件」= **标准 AI 可参考的文件**。

## 语义:什么是「标准 AI 可参考的文件」

编码 agent 的输入分两类,都按**扩展名**分类(纯函数,零依赖):

- **文本/代码文件**(`md/txt/json/ts/py/go/…` 与 `Makefile/.gitignore` 等无扩展名配置名)→ **绝对路径引用**。发送时把路径拼进 prompt,AI 用自己的 fs 工具读取(路径是文件的身份,契合「展示为绝对路径」)。
- **图片**(`png/jpg/jpeg/gif/webp/svg/…`)→ **同样绝对路径引用**。图片**不是 base64**——图片输入是「某些模型支持图片输入」的**协议/模型能力**,壳只传路径、不读文件内容、不编码 base64。
- **其余**(zip/exe/pdf 等二进制)→ **不可参考**,拒绝并 toast(显式降级,不静默)。

分类单源:`packages/shared/src/domain/composer-files.ts`(圆心纯函数),main 与 renderer 共用。

## 数据模型

- `pendingFiles: { path: string; name: string }[]`(timeline 本地状态,发送后清空;绝对路径)。**文本与图片同列表**,都只是路径引用。
- 不读 base64、不建 dataUri 预览;既有 sticker 图片流(`composerImage`/`PendingImageBar`)是独立历史功能,与本特性无关。

## 三条入口

| 入口 | 取路径方式 | 说明 |
|---|---|---|
| `+` 点击 | `dialog.openFiles()`(main 进程 `showOpenDialog`,返回绝对路径引用) | 主入口,绝对路径可靠 |
| 拖拽 | `window.mhdFile.getPathForFile(file)`(preload 暴露 `webUtils.getPathForFile`) | Electron 桌面;远程浏览器无 preload → 退化用文件名 |
| 粘贴 | 同上(剪贴板 `clipboardData.files`) | 同上 |

三者都不读文件内容、不编码 base64——只拿绝对路径。

## 发送链路

`sendText` 把「参考文件」段折进正文再走既有入队/立即发送分支(文件不入队,成为正文的一部分,避免扩队列契约):

```
参考文件:
- /abs/a.ts
- /abs/b.md
```

- 空正文门:`hasAttachments || pendingFiles.length > 0 || composerImage` 任一为真即可发送(`composerImage` 是既有 sticker 图流,与本特性无关)。
- 发送成功/入队后清 `pendingFiles`(与输入框一致)。

## 新增/改动面

- 圆心: `packages/shared/src/domain/composer-files.ts`(分类器)+ host.ts(`HostPickedFile`/`HostDialog.openFiles`)+ channel-contract(`dialog:openFiles`)。
- main: electron-host `openFiles`、node-host 降级 stub、slots-dialog 注册。
- 传输: build-kernel `dialog.openFiles`、plugin-context `dialog.openFiles`、sessions.ts `DialogApi.openFiles`、react/index.ts kernel dialog 类型。
- preload: `src/server/preload.ts` 暴露 `window.mhdFile.getPathForFile`(webUtils);electron.ts + electron.vite.config.ts 接线。
- 内容: timeline(状态/增删/拖拽粘贴/PendingFileBar/发送)、composer(`onAttach`/`onFiles`)、i18n 四语言。

## 约束

- 机制(对话框/preload/传输)在壳,内容(参考文件段/文案/分类清单)在 timeline 插件 + 圆心纯函数。
- 内核无关:文件是路径引用,不读内核存储、不按内核分支。
