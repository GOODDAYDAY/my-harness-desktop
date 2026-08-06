// markdown 插件 renderer 入口——文本块渲染件出口。
// 框架按 manifest contributes.blockRenderers[].component 名在本 module exports 自动匹配(§7.4),
// 只 export 组件,零注册调用、零字符串字面量(零硬编码纪律)。
export { Markdown as MarkdownText } from "./markdown";
