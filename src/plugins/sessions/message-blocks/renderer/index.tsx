// message-blocks 插件 renderer 入口——块级渲染件全量出口。
// 框架按 manifest contributes.blockRenderers[].component 名在本 module exports 自动匹配(§7.4),
// 只 export 组件,零注册调用、零字符串字面量(零硬编码纪律)。
// 文本块渲染(MarkdownText)已迁出为独立 markdown 插件——本插件只管工具卡/思考链/气泡/分隔线。
export { BashCard, EditCard, ReadCard, DefaultCard } from "./tool-cards";
export { ThinkingChainBlock } from "./thinking-chain-block";
export { UserBubble } from "./user-bubble";
export { CommentsOnlyBubble } from "./comments-only-bubble";
export { EntryDivider } from "./entry-divider";
export { ImageBlock } from "./image-block";
