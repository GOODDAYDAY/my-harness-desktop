# 语音输入（composerVoice 槽 + STT 纯插件）

## 1 目标

输入框右下角的麦克风按钮是一个**槽位**，等插件往里装；默认无插件时装「待接入」占位。
语音转文字（STT）是一个**纯插件**：麦克风采集 → 本地 Whisper 转写 → 文字回填输入框 → 用户手动发送。
模型权重不进 git，按需下载；引擎用现成开源项目（transformers.js / Whisper），不动桌面内核。

## 2 架构（机制 + 内容分离）

```
desktop 壳（机制）                         voice-input 插件（内容）
┌───────────────────────────┐            ┌─────────────────────────────────────┐
│ composerVoice 槽           │ ◀── 填槽 ── │ VoiceButton（composerVoice 槽贡献）   │
│  - contributions.ts 契约   │            │   idle/recording/transcribing 状态机  │
│  - registry.ts 数组槽      │            │   → onTranscribed(text) 回填         │
│  - slots-dialog.ts IPC     │            ├─────────────────────────────────────┤
│  - build-kernel.ts 桥      │            │ audio.ts：getUserMedia + MediaRecorder │
│  - useComposerVoice hook   │            │   + decodeAudioData + 重采样 16k 单声道│
│  - composer.tsx 挂载点     │            ├─────────────────────────────────────┤
│  - timeline 查槽 + 回填    │            │ stt-engine.ts：transformers.js Whisper │
└───────────────────────────┘            │   懒加载 + 模型按需下载 + 缓存         │
                                         │ settings.tsx：选模型 + 显式下载       │
                                         └─────────────────────────────────────┘
```

**核心原则（§7.7 非必要不修改内核）**：改动只落在壳的**槽位机制**（一处新增挂载点）+ **纯插件**（内容）。
不碰 pi/dsh 内核，不碰会话存储/事件/协议。

## 3 composerVoice 槽（壳机制，一次性）

契约单源在圆心，`packages/shared/src/domain/contributions.ts`：

```ts
export interface ComposerVoiceContribution {
  id: string;
  component: string;
  order?: number;   // 单一按钮槽，多贡献取 order 最小者
}
```

组件 props 契约在发布面 `packages/react/src/composer-voice.ts`：

```ts
export interface ComposerVoiceProps {
  onTranscribed: (text: string) => void;  // 转写结果回填输入框（追加语义）
  disabled?: boolean;                     // 输入框只读/未就绪时禁用
}
```

与其它 composer* 槽的唯一差异：本槽组件**带 props**——转写结果要写回输入框，不能靠组件自订阅 store 完成。
「写进哪个输入框」由挂载点（timeline）决定，插件只负责「采集 + 转写 + 报告文字」。

无贡献时，`composer.tsx` 渲染禁用态占位麦克风（`shell.voice`「待接入」文案），不静默、不伪造。

## 4 插件（voice-input，纯插件）

路径 `src/plugins/sessions/voice-input/`：

| 文件 | 职责 |
|---|---|
| `renderer/voice-button.tsx` | composerVoice 槽按钮：idle → recording → transcribing 状态机，转写完 `onTranscribed(text)` |
| `renderer/audio.ts` | 麦克风采集（getUserMedia + MediaRecorder）→ decodeAudioData 解码 → 重采样 16k 单声道 PCM |
| `renderer/stt-engine.ts` | transformers.js Whisper：懒加载引擎、模型清单（tiny/base/small）、按需下载、选择持久化 |
| `renderer/settings.tsx` | 设置页：选模型 + 显式「下载模型」按钮 + 进度 |
| `locales/*/voice.json` | 四语文案 |

## 5 STT 引擎选型

**transformers.js（`@huggingface/transformers`，Whisper ONNX）**——现成开源项目，浏览器/Electron 内
纯 WASM 运行，无需原生模块、无需后端服务：

- **引擎不进首屏**：`import("@huggingface/transformers")` 动态导入，vite 拆成独立 chunk（~2MB），
  onnxruntime wasm（~21MB）随 chunk 按需加载。
- **模型不进 git**：模型权重从 HuggingFace Hub 按需下载（`onnx-community/whisper-{tiny,base,small}`），
  默认缓存到浏览器 Cache API，二次使用离线命中。
- **8-bit 量化（`dtype: "q8"`）**：下载 `_quantized.onnx`，体积约为 fp32 的 1/3（tiny ~41MB /
  base ~77MB / small ~249MB），质量损失极小；fp32 会拉到 ~3 倍体积。
- **显式指定语言**：Whisper 无自动语言检测（transformers.js 缺省会回落英文，中文会被转成英文），
  故 `transcribe` 传 `language`（默认按 UI locale 推导中文/英文/德文，设置页可改）。
- **静音拦截**：转写前按 RMS 阈值拦静音/纯音——Whisper 对静音会幻觉出 " you"/"(whistling)" 这类文字。

## 6 发送链路

转写结果是**文字进输入框**，用户改后手动发送（与 stickers「加入输入框」同一语义，§核心就是「转文字，然后文字发送」）：

```
语音按钮 → 录音 → 停止 → STT 转写 → onTranscribed(text)
        → timeline setInput 追加（已有草稿不被顶掉，中间空一行）
        → 用户点发送 → 既有 sendText 链路（模型回灌 / 入队 / 附件）原样生效
```

不自动发送：语音可能识别错，用户先确认再发，符合会话流既有交互（review 评论篮、贴纸追加都是两段式）。

## 7 变更清单

**壳（机制，一次到位）**：
- `packages/shared/src/domain/contributions.ts` — `ComposerVoiceContribution` + `SlotName` + `PluginContributes.composerVoice`
- `packages/shared/src/channel/channel-contract.ts` — `slots.composerVoice`
- `src/server/application/loader/registry.ts` — `composerVoice` 数组槽 + `composerVoiceItems()`
- `src/server/controllers/slots-dialog.ts` — 注册 IPC
- `src/web/kernel/build-kernel.ts` — renderer 桥 `slots.composerVoice`
- `packages/react/src/composer-voice.ts` — `useComposerVoice` + `ComposerVoiceProps`
- `packages/react/src/index.ts` — slots 类型 + re-export hook
- `packages/react/src/widgets/plugin-icon.tsx` — 增加 `mic` 图标映射
- `src/plugins/sessions/timeline/renderer/composer.tsx` — `voice` prop，占位麦克风替换为槽渲染
- `src/plugins/sessions/timeline/renderer/index.tsx` — 查槽 + `onTranscribed` 回填 + 传 `voice`

**插件（内容）**：
- `src/plugins/sessions/voice-input/**`（plugin.json + renderer + locales）
- `package.json` — 新增 `@huggingface/transformers`

## 8 验证与待办

**已 headless 验证**（Node 侧真实音频回放，非 mock）：
- whisper-tiny(q8) 从 HF Hub 下载 → 推理跑通（模型 ~41MB，CORS `access-control-allow-origin: *`）。
- 中文「你好，今天天气怎么样」→「你好,今天天氣怎麼樣」（正确，繁简差异仅字形）；英文「Hello, how are you today」→「 Hello, how are you today?」（正确）。
- `language` 显式指定后不再回落英文；静音按 RMS 拦截不产生幻觉文本。
- 单测：`audio.test.ts`（重采样/静音 7 例）、`registry.test.ts`（composerVoice 注册/排序/卸载 2 例）、`composer.test.tsx`（7 例）。

**待人工冒烟**（需真实麦克风 + 联网，本仓库无法 headless 覆盖）：
1. `npm run dev` → 打开/新建会话。
2. 点输入框右下角麦克风 → macOS 授权麦克风（TCC 弹窗，一次性）。
3. 说话 → 停止 → 转写文字回填输入框 → 点发送。
4. 若 wasm 线程在 Electron 内报错（无 cross-origin isolation），回退单线程：`env.backends.onnx.wasm.numThreads = 1`。

**演进**：录音时长上限 / VAD 截断、快捷键（按住说话）。

