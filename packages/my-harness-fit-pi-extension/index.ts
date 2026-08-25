/**
 * my-harness-fit-pi-extension —— pi 内核的桌面适配扩展(统一入口)。
 *
 * 合并了原 tool-gate / context-probe / bus-extension / subagent-extension / skills-extension
 * 五个独立底座扩展为单一扩展:一个目录、一个 index.ts 入口、一个 installer 交付。
 * 各能力拆成独立模块(toolgate.ts / context-probe.ts / bus.ts / subagent.ts / skills.ts),
 * 共享机制收敛到 runtime.ts(契约单源)。
 *
 * 关键收敛:原 bus/subagent 各自挂 input 钩子、链式传递有"谁先谁后"的时序脆弱
 * (runner emitInput:transform 的输出是下一家的输入),这里收敛为单一 input 钩子 + kind 分派,
 * pending Map 也合并为一张表(replyTo 是 randomUUID,无碰撞)——消掉时序脆弱。
 *
 * 交付:client/pi/my-harness-fit-pi-extension-installer.ts 在 app 启动时同步本目录到
 * ~/.pi/agent/extensions/my-harness-fit-pi-extension/。
 */
import {
  formatFrame, takePending,
  type BusFrame, type ExtensionApi,
} from "./runtime";
import { setupToolgate } from "./toolgate";
import { setupContextProbe } from "./context-probe";
import { setupSkills } from "./skills";
import { setupBus } from "./bus";
import { setupSubagent } from "./subagent";

export default function (pi: ExtensionApi): void {
  // 单一 input 钩子:$bus 帧路由(响应帧 handled 吞帧 resolve,事件帧 transform 人话化)。
  pi.on("input", (event) => {
    const raw = event?.text;
    if (typeof raw !== "string" || !raw.startsWith("{")) return;
    let frame: BusFrame;
    try {
      frame = JSON.parse(raw) as BusFrame;
    } catch {
      return;
    }
    if (frame?.$bus !== true) return;
    if (event.source && event.source !== "rpc") return; // 人类手敲的 $bus JSON 透传,不吞不改写
    if (frame.kind === "bus_response" && typeof frame.replyTo === "string") {
      const resolve = takePending(frame.replyTo);
      if (resolve) {
        resolve(frame.payload);
        return { action: "handled" };
      }
      return; // 已超时/未知 replyTo:放行
    }
    return { action: "transform", text: formatFrame(frame), images: event.images };
  });

  setupToolgate(pi);
  setupContextProbe(pi);
  setupSkills(pi);
  setupSubagent(pi);
  setupBus(pi);
}
