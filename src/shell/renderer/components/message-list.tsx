// 消息列表(对话区) —— timeline 插件的临时静态骨架。
//
// 依据 docs/plugins/08(timeline 插件):真正的消息流来自 pi 的 event 流 +
// get_entries 历史,经 cardRenderers 槽渲染。这里是验证布局的占位骨架,
// 内容是硬编码占位,等加载器 + RPC 对接后替换成真实 timeline 实现。
import { Button } from "../ui/button";

interface PlaceholderMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  toolName?: string;
}

const MESSAGES: PlaceholderMessage[] = [
  { role: "user", content: "帮我看下这个项目的目录结构,梳理一下架构。" },
  {
    role: "assistant",
    content:
      "好的,我先扫一下项目根目录和设计文档,理清四根支柱和洋葱六层的依赖关系,然后给你一个结构化的梳理。",
  },
  {
    role: "tool",
    toolName: "bash",
    content: "$ ls -la /Users/user/self/git-project/pi-desktop\n$ find docs -name '*.md'",
  },
  {
    role: "assistant",
    content:
      "这是一个 VSCode 式薄壳桌面应用:core 只提供机制(四根支柱),一切功能是插件,pi 底座是被管理对象。源码按激进洋葱六层切分——domain(圆心)→ gateway(协议边界)→ application(用例编排)→ shell(会变细节)→ plugins(内容)→ packages(外层资产)。",
  },
  { role: "user", content: "那它的主题系统是怎么做的?" },
];

function MessageBubble({ msg }: { msg: PlaceholderMessage }): React.ReactNode {
  if (msg.role === "tool") {
    return (
      <div
        style={{
          margin: "var(--spacing-sm) 0",
          padding: "var(--spacing-sm) var(--spacing-md)",
          background: "var(--color-surface)",
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius-md)",
          fontFamily: "var(--font-family-mono)",
          fontSize: "var(--font-size-sm)",
          color: "var(--color-muted)",
          whiteSpace: "pre-wrap",
        }}
      >
        <div style={{ fontFamily: "var(--font-family-sans)", color: "var(--color-accent.warning)", marginBottom: "var(--spacing-xs)" }}>
          [tool] {msg.toolName}
        </div>
        {msg.content}
      </div>
    );
  }
  const isUser = msg.role === "user";
  return (
    <div
      style={{
        display: "flex",
        justifyContent: isUser ? "flex-end" : "flex-start",
        margin: "var(--spacing-sm) 0",
      }}
    >
      <div
        style={{
          maxWidth: "80%",
          padding: "var(--spacing-sm) var(--spacing-md)",
          background: isUser ? "var(--color-primary)" : "var(--color-surface)",
          color: isUser ? "var(--color-primary-fg)" : "var(--color-fg)",
          borderRadius: "var(--radius-md)",
          whiteSpace: "pre-wrap",
        }}
      >
        {msg.content}
      </div>
    </div>
  );
}

export function MessageList(): React.ReactNode {
  return (
    <div
      style={{
        flex: 1,
        overflowY: "auto",
        padding: "var(--spacing-lg) var(--spacing-xl)",
      }}
    >
      {MESSAGES.map((msg, i) => (
        <MessageBubble key={i} msg={msg} />
      ))}
      <div style={{ textAlign: "center", color: "var(--color-muted)", fontSize: "var(--font-size-sm)", marginTop: "var(--spacing-lg)" }}>
        —— 占位消息,接 pi 后替换为真实 timeline ——
      </div>
    </div>
  );
}

/** 输入框(和消息流一体,贴在对话区底部)。 */
export function Composer(): React.ReactNode {
  return (
    <div
      style={{
        borderTop: "1px solid var(--color-border)",
        padding: "var(--spacing-md) var(--spacing-xl)",
        display: "flex",
        gap: "var(--spacing-sm)",
        alignItems: "flex-end",
      }}
    >
      <textarea
        placeholder="给 agent 发消息…  (Cmd+Enter 发送)"
        style={{
          flex: 1,
          resize: "none",
          minHeight: "var(--spacing-xl)",
          maxHeight: "120px",
          padding: "var(--spacing-sm) var(--spacing-md)",
          background: "var(--color-surface)",
          color: "var(--color-fg)",
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius-md)",
          fontFamily: "var(--font-family-sans)",
          fontSize: "var(--font-size-base)",
          outline: "none",
        }}
        rows={1}
      />
      <Button variant="primary" size="md">
        发送
      </Button>
    </div>
  );
}
