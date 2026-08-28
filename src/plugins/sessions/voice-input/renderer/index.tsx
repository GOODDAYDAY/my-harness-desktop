// voice-input 插件 renderer 入口 —— manifest component 名与 export 一一对应(框架自动匹配)。
//
// 设计文档:docs/design/voice-input.md。要点:
// - 语音按钮走 composerVoice 槽(desktop 壳新增的挂载点),插件只填槽不改壳;
// - STT 用 transformers.js Whisper(现成开源项目),引擎懒加载、模型按需下载(不进 git);
// - 转写结果经 onTranscribed 回填输入框(追加语义),用户改后手动发送——核心就「转文字,然后文字发送」;
// - 设置页提供模型选择 + 显式下载。
export { VoiceButton } from "./voice-button";
export { VoiceSettings } from "./settings";
