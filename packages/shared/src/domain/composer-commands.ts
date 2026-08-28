// 圆心:输入框斜杠命令契约(纯类型 + 纯函数,零依赖)。
//
// 定位:机制契约。内核命令(snapshot.commands,source=skill/extension/prompt)由内核注册、
// 内核执行;壳插件命令(source=plugin)由插件经 renderer module 的 composerCommands 导出
// (与 channels/auxParsers 同款收集模式)、在**发送前**由消费方(timeline)拦截执行——
// 命中即吞掉本次发送,文本不进内核。goal 插件的 /goal 是首个消费方。
//
// 注册表与执行胶水在 packages/react/src/composer-commands.ts(发布面机制),本文件只留契约与纯解析。

/** 插件注册的输入框斜杠命令。handle 返回 true = 已处理(吞掉发送);false = 放行(按普通消息发送)。 */
export interface ComposerCommand {
  /** 命令名(不带前导 /),如 "goal"。输入 "/goal ..." 命中;名字比较大小写不敏感。 */
  name: string;
  /** 一句话说明(进斜杠弹窗)。 */
  description?: string;
  /** 处理以 /name 开头的原始输入全文。抛错按未处理(放行)兜底。 */
  handle: (input: string) => boolean | Promise<boolean>;
}

/** 解析输入首行的命令头:"/goal xxx" → { name: "goal", rest: "xxx" }。
 *  不以 / 开头、或 / 后无名字 → null。rest 是命令名之后的**全文**(含后续行),已去首尾空白。 */
export function parseComposerCommandText(text: string): { name: string; rest: string } | null {
  if (!text.startsWith("/")) return null;
  // 命令头只取首行;rest 保留全文(多行 objective 合法)。
  const nl = text.indexOf("\n");
  const firstLine = nl === -1 ? text : text.slice(0, nl);
  const m = firstLine.match(/^\/([^\s/]+)(.*)$/);
  if (!m) return null;
  const rest = text.slice(m[1].length + 1).trim();
  return { name: m[1], rest };
}

/** 在命令清单里按名字(大小写不敏感)找命中项;无命中返回 null。 */
export function matchComposerCommand(text: string, commands: ComposerCommand[]): ComposerCommand | null {
  const head = parseComposerCommandText(text);
  if (head === null) return null;
  const lower = head.name.toLowerCase();
  return commands.find((c) => c.name.toLowerCase() === lower) ?? null;
}
