// message-blocks 插件 renderer 入口——块级渲染件全量出口。
// 框架按 manifest contributes.blockRenderers[].component 名在本 module exports 自动匹配(§7.4),
// 只 export 组件,零注册调用、零字符串字面量(零硬编码纪律)。
export { BashCard, EditCard, ReadCard, DefaultCard } from "./tool-cards";
export { ThinkingChainBlock } from "./thinking-chain-block";
export { Markdown as MarkdownText } from "./markdown";
export { UserBubble } from "./user-bubble";
export { EntryDivider } from "./entry-divider";
