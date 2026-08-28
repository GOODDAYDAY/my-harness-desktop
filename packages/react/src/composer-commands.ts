// composer-commands.ts —— 输入框斜杠命令注册表(renderer 侧机制,镜像 aux-block-parsers)。
//
// plugins-host 加载插件 module 时收集 mod.composerCommands 进本注册表(与 channels/auxParsers 同模式);
// 消费方两处:
//  ① timeline 发送前经 runComposerCommandIfMatch 拦截——命中且 handle 返回 true 即吞掉发送;
//  ② timeline 把注册表映射成 CommandItem(source="plugin")并入斜杠弹窗清单。
// 命令是纯运行时对象(含闭包),卸载插件后摘除,与 auxParsers 同生命周期。
import type { ComposerCommand } from "@my-harness-desktop/shared";
import { matchComposerCommand } from "@my-harness-desktop/shared";

const commands: ComposerCommand[] = [];

export function registerComposerCommands(cmds: ComposerCommand[]): void {
  for (const c of cmds) {
    const idx = commands.findIndex((x) => x.name.toLowerCase() === c.name.toLowerCase());
    if (idx >= 0) commands[idx] = c;
    else commands.push(c);
  }
}

export function unregisterComposerCommands(names: string[]): void {
  const lower = names.map((n) => n.toLowerCase());
  for (let i = commands.length - 1; i >= 0; i--) {
    if (lower.includes(commands[i].name.toLowerCase())) commands.splice(i, 1);
  }
}

export function getComposerCommands(): ComposerCommand[] {
  return commands;
}

/** 发送前拦截:文本命中注册命令则执行 handle。
 *  返回 true = 已处理(调用方吞掉本次发送);false = 未命中/未处理(照常发送)。
 *  handle 抛错按未处理兜底(一个插件的命令故障不得阻塞用户发送)。 */
export async function runComposerCommandIfMatch(text: string): Promise<boolean> {
  const cmd = matchComposerCommand(text, commands);
  if (!cmd) return false;
  try {
    return (await cmd.handle(text)) === true;
  } catch (err) {
    console.warn(`[composer-commands] 命令 /${cmd.name} 执行异常,按普通消息放行:`, err);
    return false;
  }
}
