# voice-input 插件技术文档

voice-input（语音输入）是会话域里唯一一个"本地推理"插件：它在 composer 右下角贡献一个麦克风按钮，点击录音、本地 Whisper 模型转写成文字、回填输入框，用户改后手动发送。它与其他四个插件的关键区别是**自带一个重型模型引擎**——transformers.js 的 Whisper（几十~几百 MB 权重），这条引擎完全住在插件目录内（`renderer/stt-engine.ts` + `renderer/audio.ts`），懒加载、模型按需下载不进 git，桌面壳不为此改一行机制。它是"机制与内容分离"的正面标本：composer 只提供一个 `composerVoice` 挂载点（机制），模型/音频采集/转写全归插件（内容）；它也是 §7.7"非必要不修改内核"的标本——STT 能力全部在插件内，不动桌面壳的内核。

## 1 职责与边界

- 职责一句话：**麦克风录音 → 本地 Whisper 转写 → 文字回填输入框**。核心就是"转文字，然后文字发送"（renderer/index.tsx 第 6 行注释），插件只负责产出文字，"写进哪个输入框"由挂载点决定。
- 设计目标（stt-engine.ts 第 3–5 行注释）三条：本插件是纯内容插件，STT 能力全部在本插件内，不动桌面壳内核；引擎库 `@huggingface/transformers` 只在首次转写时动态 import，不随插件首屏打包；模型权重绝不进 git，首次使用时从 HuggingFace Hub 按需下载，transformers.js 默认缓存到浏览器 Cache API，二次使用离线命中。
- 依赖严格向内：`renderer/` 各文件从 `@my-harness-desktop/react` 取 `usePluginContext` / `ComposerVoiceProps` / `SettingsSection`，从 `@my-harness-desktop/shared` 取 `PluginContext` 类型，从 `react-i18next` 取 `useTranslation`，从 `lucide-react` 取 `Mic` / `Square` / `Loader2` / `Download` / `Check` 图标。唯一的重型外部依赖是 `@huggingface/transformers`，且它只在 `stt-engine.ts` 的 `loadPipeline` 里**动态 import**，不进插件模块的静态 import 图。
- 目录形态：`plugin.json` + `renderer/{index.tsx, voice-button.tsx, stt-engine.ts, audio.ts, audio.test.ts, settings.tsx}` + 四个 locale 文件，无 `core/`、无 `pi-extension/`、无 `dsh-extension/`。无权限声明——`getUserMedia` 是浏览器/Electron 内建 API，不是壳后端的 scoped 能力（§8.1 的声明能力 fs/git/llm/bus/bash 都不涉及麦克风）。

## 2 目录与文件清单

```
src/plugins/sessions/voice-input/
├── plugin.json
├── renderer/
│   ├── index.tsx           # 只 re-export VoiceButton / VoiceSettings
│   ├── voice-button.tsx    # VoiceButton：composerVoice 槽的语音按钮（状态机 + 录音 + 转写）
│   ├── stt-engine.ts       # STT 引擎：transformers.js Whisper，懒加载 + 模型按需下载
│   ├── audio.ts            # 麦克风采集 + 解码 + 重采样（纯 Web API，零依赖）
│   ├── audio.test.ts       # 纯函数单测：重采样 + 静音判定
│   └── settings.tsx        # VoiceSettings：模型选择 + 按需下载设置页
└── locales/{zh-CN,zh-TW,en,de}/voice.json
```

- `plugin.json` 贡献三个槽：`composerVoice` 一项 `{ id: "voice-input", component: "VoiceButton", order: 10 }`，`settings` 一项 `{ id: "voice-input", title: "语音输入", icon: "mic", component: "VoiceSettings", configFile: null, saveMode: "manual", order: 85 }`，`languages` 四项（四 locale 的 `voice-input.voice` 命名空间）。
- `renderer/index.tsx` 只有两行 re-export（`export { VoiceButton } from "./voice-button"`、`export { VoiceSettings } from "./settings"`），顶部注释点明设计文档 `docs/design/voice-input.md` 与四个要点：语音按钮走 `composerVoice` 槽、STT 用 transformers.js Whisper、转写结果经 `onTranscribed` 回填、设置页提供模型选择 + 显式下载。
- `stt-engine.ts`（151 行）是引擎层：模型清单 `STT_MODELS`、语言清单 `STT_LANGUAGES`、config 读写（`getModelId` / `setModelId` / `getLanguage` / `setLanguage`）、管道懒加载 `loadPipeline`、转写 `transcribe`、主动下载 `downloadModel`。
- `audio.ts`（157 行）是采集层：`MicRecorderImpl` 封装 `MediaStream` + `MediaRecorder`，`blobTo16kMono` 解码重采样成 16kHz 单声道 PCM，`resampleTo16kMono` 均值混音 + 线性插值重采样，`isSilence` 静音判定。纯 Web API 零依赖，不引入原生模块。
- `audio.test.ts`（57 行）是采集层的纯函数单测：`resampleTo16kMono`（单声道 16k 原样拷贝、立体声混音取均值、48k→16k 降采样长度约 1/3）与 `isSilence`（全零静音、低幅度噪声静音、正常语音非静音、空采样静音），不含 DOM/MediaRecorder 可裸跑。

## 3 plugin.json 与贡献的槽

- `composerVoice` 槽是 voice-input 的主挂载点，槽位契约 `ComposerVoiceContribution`（`packages/shared/src/domain/contributions.ts` 第 292 行）：`{ id, component, order? }`，`order` 语义是"多个贡献时取 order 最小者（单一按钮槽）"。这个槽是"插件往 composer 右下角贡献语音输入按钮"，消费方（timeline）查槽后按 `getPluginComponent` 匹配组件、渲染进 Composer 右侧（原语音占位按钮的位置）。
- 槽位契约注释里的关键句（第 290 行）："无贡献时 composer 显示禁用态占位麦克风（「待接入」提示，不静默、不伪造）。模型/音频采集等一切内容归贡献方插件，壳只提供挂载点"——这是机制/内容分离的正面标本：composer 只有"右下角有一个麦克风挂载点"这个机制，麦克风背后是录音还是别的、模型是什么，全归插件。
- `ComposerVoiceProps`（`packages/react/src/composer-voice.ts` 第 16 行）是本槽组件独有的 props 契约：`{ onTranscribed: (text: string) => void; disabled?: boolean }`。`onTranscribed` 是"转写完成回调：把识别文字写进输入框（追加语义，已有草稿不被顶掉）"，`disabled` 由消费方传入（输入框只读/未就绪时禁用）。这是本槽与其它 `composer*` 槽的关键区别——其它槽组件 props 无（自订阅插件内状态），本槽带回调，因为转写结果要写回输入框，不能靠组件自订阅 store 完成。
- `settings` 槽贡献 `VoiceSettings`：`SettingsContribution`（contributions.ts 第 9 行）里 `configFile: null`（无配置文件，不显示打开按钮）、`saveMode: "manual"`（实时生效，无保存浮层，仅打开按钮）。这是因为 voice-input 的配置（模型/语言）走 `ctx.config.get/set`（插件统一配置通道），不依赖框架的 configFile 读写管线的 dirty/save 浮层——`saveMode: "manual"` 声明"改了就生效，不需要保存按钮"。
- `useComposerVoice`（`composer-voice.ts` 第 26 行）是 renderer 侧查槽 hook，机械镜像其它 composer* 槽："同 nonce 单发，失效重拉"——`pluginsNonce = useUiStore((s) => s.pluginsNonce)`，`window.kernel.slots.composerVoice()` 拉贡献项，缓存 `{ nonce, data }`。消费方（timeline）经此取到 `VoiceButton` 组件并渲染。

## 4 渲染逻辑：VoiceButton 状态机

- `VoiceButton({ onTranscribed, disabled }: ComposerVoiceProps)`（voice-button.tsx 第 15 行）是三态状态机：`type VoiceState = "idle" | "recording" | "transcribing"`（第 13 行）。
- 图标三态（第 84–90 行）：`idle` → `Mic` 图标；`recording` → `Square` 图标（红色脉冲 `animation: pulse 1.4s ease-in-out infinite`）；`transcribing` → `Loader2` 图标（`animate-spin`）。按钮背景在 recording 时变 `var(--color-accent-error)`、图标变 `var(--color-bg)`。
- `toggle`（第 29–68 行）是核心状态迁移：`disabled` 或 `transcribing` 时直接 return（转写中不能再点）；`recording` → 停止录音、`setState("transcribing")`、`rec.stop()` 拿采样、`isSilence(samples)` 先拦静音、`transcribe(ctx, samples)` 转写、有文字 `onTranscribed(text)` 否则报空、finally `rec.dispose()` + `setState("idle")`；`idle` → `MicRecorderImpl.create()` + `rec.start()` + `setState("recording")`。
- 静音前置拦截（第 40–44 行）：`if (isSilence(samples)) { flashError(t("voice.empty")); return; }`——Whisper 对静音/纯音会幻觉出文字（" you" / "(whistling)"，audio.ts 第 149 行注释），转写前先拦一道，不进引擎、不产生幻觉文本。这是"根因修复不打补丁"的落地：不是转写后过滤幻觉文本，而是在转写前把静音拦掉。
- 错误处理（第 23–27 行 `flashError` + 第 48–52 行 catch）：`flashError(msg)` 设 error 状态、4 秒自动清除（`errorTimerRef` + `clearTimeout`）。录音失败（麦克风权限/无设备）`flashError(t("voice.micDenied"))`，转写失败 `flashError(t("voice.error"))`。`title`（第 70 行）优先显示 error，其次按状态显示 recording/transcribing/mic 的 title。
- `disabled` prop 的语义（composer-voice.ts 第 19 行）："输入框不可用（未选项目/未装内核）时由消费方传入禁用"。VoiceButton 收到 `disabled` 时按钮 `opacity-30 cursor-default`、`toggle` 直接 return——无贡献时 composer 自画禁用占位麦克风（槽位契约第 290 行），有贡献但输入框不可用时消费方传 disabled 禁用本按钮。

## 5 采集层：audio.ts 的纯 Web API 管线

- `MicRecorder` 接口（audio.ts 第 8 行）：`{ start, stop, cancel, dispose }`。`stop` 返回 16kHz 单声道 Float32Array（幂等，重复调用返回缓存结果），`cancel` 丢弃录音不触发 decode，`dispose` 释放麦克风流。
- `MicRecorderImpl`（第 28 行）是单次录音封装：`private constructor` 持有 `stream` + `recorder` + `chunks`，`create()`（第 47 行）先查 `navigator.mediaDevices?.getUserMedia` 存在性，再 `getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } })`——单声道 + 回声消除 + 噪声抑制 + 自动增益，把采集质量在源头就提上去。getUserMedia 被拒（权限/无设备）抛错，由调用方显形（`flashError`）。
- `pickMimeType()`（第 19 行）：候选 `["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"]`，`MediaRecorder.isTypeSupported` 逐个测，都不支持回退浏览器默认。
- `start()`（第 62 行）：`this.recorder.start(250)`——每 250ms 出一片，减少内存峰值（不是录完一整段再切）。
- `stop()`（第 66–86 行）：`decoded` 缓存幂等；`onstop` 里 `new Blob(chunks, { type: recorder.mimeType })` 再 `blobTo16kMono(blob)` 解码重采样；`stopped && chunks.length === 0` 时直接返回空采样。`stopped` 标记拦 `cancel` 后仍触发的 onstop（第 88–97 行 `cancel` 置 `stopped = true` + 清 chunks + `onstop = null`）。
- `blobTo16kMono`（第 112 行）：`blob.arrayBuffer()` → 单例 `AudioContext`（`getAudioCtx`，第 106 行，避免反复创建触浏览器上限）→ `decodeAudioData` → `resampleTo16kMono`。
- `resampleTo16kMono`（第 121 行）：单声道 16k 直接拷贝（第 124–126 行短路）；否则多声道均值混音 + 线性插值重采样到 16k（第 130–145 行）。这是 Whisper 的输入要求——16kHz 单声道 PCM，`Float32Array`。
- `isSilence(samples, threshold = 0.004)`（第 151 行）：RMS（均方根）低于阈值判静音。空采样恒 true。阈值 0.004 是经验值，测试里"低幅度噪声 0.001 判静音、正常语音 0.5 判非静音"覆盖了边界。

## 6 引擎层：stt-engine.ts 的 Whisper 管线

- 模型清单 `STT_MODELS`（第 21 行）：`onnx-community/whisper-tiny`（~40 MB）、`whisper-base`（~77 MB）、`whisper-small`（~244 MB）。`DEFAULT_MODEL = "onnx-community/whisper-base"`（第 27 行）。这些是 transformers.js v3 官方推荐的多语 Whisper ONNX（含中文），体积为约值供设置页提示。
- 语言清单 `STT_LANGUAGES`（第 33 行）：`chinese` / `english` / `german`。关键约束（第 32 行注释）："Whisper 无自动检测，须显式指定，否则默认英文会把中文转成英文"——这是转写语言显式化的根因。
- `LOCALE_TO_LANG`（第 40 行）是 UI locale → Whisper 语言码的映射：`zh-CN/zh-TW/zh` → chinese，`en/en-US/en-GB` → english，`de/de-DE` → german。`getLanguage`（第 81 行）：显式 config 优先，否则按 `ctx.i18n.locale` 推导，`locale.split("-")[0]` 再兜底 chinese。
- config 读写（第 66–94 行）：`getModelId` / `setModelId` / `getLanguage` / `setLanguage` 都经 `ctx.config.get/set`，key 是 `"model"` / `"language"`。`getModelId` 校验值在 `STT_MODELS` 里，非法回退 `DEFAULT_MODEL`；`getLanguage` 校验值在 `STT_LANGUAGES` 里，非法回退 locale 推导。config 不可用时（try/catch）按默认走，不阻塞转写。
- `loadPipeline(modelId, onProgress?)`（第 98 行）是懒加载核心：同模型复用（`pipelinePromise && loadedModel === modelId` 直接返回）；换模型释放旧权重（`prev.then((p) => p.dispose?.())`，避免多个 Whisper 权重常驻内存）；`await import("@huggingface/transformers")` 动态 import；`env.allowLocalModels = false`（允许从 HF Hub 下载）；`pipeline("automatic-speech-recognition", modelId, { dtype: "q8", progress_callback })`。
- `dtype: "q8"`（第 116 行注释）是体积/质量权衡：8-bit 量化权重（`_quantized.onnx`）体积约 1/3~1/4，质量损失极小，与设置页标注体积一致；fp32 会拉到 ~3 倍。
- `progress_callback` 是 `pipeline()` 的**构造期**选项（非 call 期，第 96 行注释），经 `loadPipeline` 透传下载进度——`downloadModel` 用它显示进度条。
- `transcribe(ctx, samples)`（第 132 行）：`samples.length === 0` 直接返回空；读 modelId + language；`loadPipeline` 拿管道；`transcriber(samples, { language })` 转写；`extractText` 解包（数组 join、对象取 `.text`）。`AsrOutput` / `AsrPipeline`（第 47–51 行）是转写输出的宽松形状（避免静态 import 重型库拿类型；动态 import 结果不强类型）。
- `downloadModel(modelId, onProgress?)`（第 143 行）：`loadPipeline` 后对 1 秒静音（`new Float32Array(16000)`）跑一次 pipeline，强制触发权重下载——"足够触发权重下载，又不会产生可读文本"。设置页的"下载模型"按钮经此把下载做成显式可预期动作。

## 7 设置页：VoiceSettings

- `VoiceSettings`（settings.tsx 第 14 行）用框架的 `SettingsSection`（`@my-harness-desktop/react`）组件包裹，`title` / `description` 走 i18n（`t("voice.settingsTitle")` / `t("voice.settingsDesc")`）。
- 三个区块：**模型选择**（`STT_MODELS.map` 按钮组，选中带 `Check` 图标 + 主色边框，`choose(id)` 里 `setModel(id)` + `await setModelId(ctx, id)`）；**语言选择**（`STT_LANGUAGES.map` 按钮组，`setLanguageId(l.id)` + `await setLanguage(ctx, l.id)`）；**下载**（`download()` 调 `downloadModel(model, (p) => setProgress(p))`，进度条 + 完成态 `done`）。
- 进度呈现（第 50–52 行 + 122–135 行）：`pct = Math.round(progress.progress * 100)`（progress 在 0~1 时），进度条 `width: ${pct}%`，右侧显示 `progress.file ?? progress.status` 与 `pct%`。`DownloadProgress`（stt-engine.ts 第 54 行）是 transformers.js `progress_callback` 的回调形状：`{ status, file?, loaded?, total?, progress? }`。
- 显式下载与按需下载的关系（settings.tsx 第 5 行注释）："不下载也能用——首次转写时引擎自动按需下载，此页只是把下载做成显式可预期动作"。"下载模型"按钮对静音跑一次 pipeline，把网络下载这个不可预期的大动作提前到用户可控的设置页，而非首次转写时突然卡住。

## 8 与其他插件/槽位交互（专节）

- **贡献的槽位名**：`composerVoice`（`VoiceButton`，`id: "voice-input"`，`order: 10`）、`settings`（`VoiceSettings`，`configFile: null`，`saveMode: "manual"`，`order: 85`）、`languages`（四 locale 的 `voice` 命名空间）。
- **composerVoice 槽的消费方是 timeline**：timeline 经 `useComposerVoice` 查槽，取 `VoiceButton` 组件渲染进 Composer 右下角，并注入 `onTranscribed` / `disabled` props。`onTranscribed` 是"追加语义"（已有草稿不被顶掉），由 timeline 的 Composer 实现——贡献方只报告文字，写进哪个输入框、追加还是覆盖，由挂载点决定（voice-button.tsx 第 5 行注释"与 stickers 的加入输入框同一思路"）。
- **dependsOn**：**无**。voice-input 不 export 自己的 `channels`，不 `emit`/`invoke`/`on` 任何插件 channel。它对 timeline 的依赖是"槽位被 timeline 消费"，不是"消费 timeline 的 channel"——若 timeline 被删，`VoiceButton` 无人挂载，但 `VoiceSettings`（settings 槽）照常可用。这是"只贡献槽、不消费别人 channel"的插件，无需 dependsOn。
- **消费的框架 API**：`ctx.config.get/set`（模型/语言配置，统一配置通道）、`ctx.i18n.locale`（语言推导）、`useTranslation().t`（i18n）、`SettingsSection`（框架样式组件）、`ComposerVoiceProps` 类型（react 发布面）。无 `ctx.sessions` / `ctx.messaging` / `ctx.tree` 等会话操作——语音输入不触发任何会话意图，转写结果经 `onTranscribed` 回填后由用户手动发送。
- **消费的浏览器/Electron 原生 API**：`navigator.mediaDevices.getUserMedia`（麦克风）、`MediaRecorder`（录音）、`AudioContext.decodeAudioData`（解码）、`Cache API`（transformers.js 模型缓存，引擎内建）。这些不是壳后端能力，不在 `permissions` 声明范围——voice-input 的 `plugin.json` 无 `permissions` 字段。
- **与其它 composer* 槽的关系**：`composerVoice` 与 `composerActions` / `composerStats` / `composerTop` / `composerAttachments` 是同一组 composer 挂载点（§7.3），各占一个位置（右下角/底部工具栏/中段/上方/停靠区）。voice-input 只占 `composerVoice`（右下角），与 token-stats 的 `composerStats`（中段）、stickers 的 `composerActions`（底部）互不冲突。

## 9 QA

**Q：模型权重为什么不进 git，用户第一次用会怎样？**

权重几十~几百 MB，进 git 会把仓库撑爆。首次转写（或点设置页"下载模型"）时 `loadPipeline` 里 `env.allowLocalModels = false` 允许从 HuggingFace Hub 下载，`dtype: "q8"` 用 8-bit 量化把体积压到约 1/3~1/4，transformers.js 下载后缓存到浏览器 Cache API，二次使用离线命中。首次会慢（下载），之后离线可用——这是"按需下载 + 浏览器缓存"的本地推理标准姿势。

**Q：为什么转写语言必须显式指定，不能自动检测？**

Whisper 无语言自动检测能力，不指定默认英文，会把中文录音转成英文文本。所以 `stt-engine.ts` 里 `transcribe` 必须传 `language`，`getLanguage` 按"显式 config → UI locale 推导 → 兜底 chinese"三级取语言码，`LOCALE_TO_LANG` 把 `zh-CN` 等映射到 `chinese`。这是根因修复（Whisper 的固有约束），不是补丁。

**Q：静音录音会怎样？**

`VoiceButton.toggle` 停止录音后先 `isSilence(samples)` 拦一道：静音/纯音直接 `flashError(t("voice.empty"))` 返回，不进 `transcribe`。因为 Whisper 对静音/纯音会幻觉出文字（" you" / "(whistling)"），进引擎既浪费算力又产生幻觉文本。阈值 0.004（RMS）在 `audio.test.ts` 里覆盖了"低幅度噪声判静音、正常语音判非静音"的边界。

**Q：换模型时旧的 Whisper 权重会一直占内存吗？**

不会。`loadPipeline` 换模型时（`loadedModel !== modelId`）会 `prev.then((p) => p.dispose?.())` 释放旧 pipeline（第 104–106 行），避免多个 Whisper 权重（每个几十~几百 MB）常驻内存。同模型复用直接返回缓存的 `pipelinePromise`。这是引擎层对内存的主动管理，不是依赖 GC。

**Q：语音输入和 session-colors 一样没声明 dependsOn，为什么？**

因为两者都是"只贡献槽、不消费别人 channel"的插件。voice-input 贡献 `composerVoice` / `settings` / `languages`，不 export 自己的 channel、不 `invoke`/`on` 别人的 channel——它唯一的外部耦合是"timeline 消费 composerVoice 槽"，这是消费方主动查槽，不是贡献方依赖消费方。timeline 被删，voice-input 照常加载、设置页照常可用，只是按钮无人挂载。凡真正消费别人 channel 才声明 dependsOn（§8.2），只是"槽位被消费"不声明。

**Q：`saveMode: "manual"` 和 `configFile: null` 对 voice-input 的设置意味着什么？**

voice-input 的配置（模型/语言）走 `ctx.config.get/set`（插件统一配置通道，`<cwd>/.my-harness-desktop/config/voice-input.json` 项目级 + 全局兜底），不走框架的 configFile 读写管线。所以 `settings` 槽声明 `configFile: null`（不显示"打开配置"按钮）和 `saveMode: "manual"`（改了就实时生效，无 dirty/保存浮层）——配置的真相源是 `ctx.config`，不是某个 configFile，框架的 save/dirty 机制对 voice-input 不适用。这与其他用 configFile 的插件（如各类 manager）形成对比。
