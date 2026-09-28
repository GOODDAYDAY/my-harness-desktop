// 事件总线 channel 的注册 ⇔ 收发对账（r74）。
//
// ## 被守的缺陷：向未注册频道发送 = **路径相关的运行时抛错**
//
// `EventBus.emit` / `invoke` 对未注册频道是**抛错**（不是静默丢）：
//   `throw new Error(\`plugin ${pluginId} emit 未声明的 channel ${channel}\`)`
//   `throw new Error(\`plugin ${callerId} invoke 的 channel ${channel} 未被任何已加载插件注册\`)`
// 抛错听起来"够响亮"，但它只在**用户走到那条路径时**才发生——某个快捷键组合、
// 某个文件动作、某个面板的 revealOn。这类路径恰恰是自动化最容易漏的
// （r26 就记着"附件链的拖拽/粘贴没有自动化覆盖"）。
// 所以静态对账有独立价值：**在没人触发之前就发现"这个频道没人注册"**。
//
// 反方向也守：注册了却既无人发也无人听的频道是**死声明**（噪声，且让人以为有这条通路）。
//
// ## 判据的四个注册来源（少算一个就会产假阳性）
//
// 1. 插件的 `export const channels = [...]`（框架经 `plugins-host.ts` 自动 registerChannels）
// 2. 壳侧自己注册：`eventBus.registerChannels("shell", ["shell:openSettings", "shell:backToChat"], …)`
//    —— 它不是插件，所以不会出现在任何 `channels` 导出里（首版就漏了这两个）
// 3. **约定频道**：`<pluginId>:fileActionInvoke`（`contributions.ts` 写明这是约定频道，
//    由 `file-actions.ts` 的 `fileActionInvokeChannel(pluginId)` **动态拼名**后 invoke，
//    所以全仓找不到这个字符串的发送点）
// 4. manifest 的 `revealOn`（框架订阅它来自动展开面板，例如 `subagent:dialog`）
//
// ## 收发形态（首版漏了两种，都造成了假阳性）
//
// 动词有三个：`emit` / `invoke` / `send`；每个都有 `.` 与 **`?.`** 两种形态
// （真实代码里就有 `ctx.events?.emit("subagent:dialog")`——首版的 `\.\s*emit` 匹配不到 `?.emit`）。
// `invoke` 的频道名还可能在**第二个实参**（`invoke(callerId, channel, payload)`）。
//
// ⚠ **必须把收发方限定到事件总线对象**（`ctx.events` / `eventBus` / `events`）：
// 首版按任意 `.on("…")` 匹配，于是把 **WS transport 的频道**（`transport.on("session:event")`、
// `"plugins:changed"`、`"restart:state"` 等 17 个）全算成了"监听了但未注册的事件总线频道"。
// 两套频道名字空间不同、注册机制也不同，混算必然产假阳性。
//
// r74 实测：注册 17 个（+ 路由 7 + 约定 2），死声明 **0**、未注册发送 **0**、未注册监听 **0**。

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CORPUS_ROOTS = ["src/plugins", "src/web", "packages/react/src", "test-plugins"];

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) { if (name !== "node_modules" && !name.startsWith(".")) walk(full, out); }
    else if ((/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !full.includes("/locales/")) || name === "plugin.json") out.push(full);
  }
  return out;
}

function corpus(): Map<string, string> {
  const out = new Map<string, string>();
  for (const root of CORPUS_ROOTS) {
    for (const f of walk(join(ROOT, root))) {
      out.set(relative(ROOT, f), readFileSync(f, "utf-8").replace(/\/\*[\s\S]*?\*\//g, ""));
    }
  }
  return out;
}

/** 事件总线对象的调用前缀（⚠ 不含 transport：那是另一套频道名字空间）。 */
const BUS = String.raw`(?:ctx\.events|eventBus|\bevents)\s*\??\.`;
// ⚠ **两个对象的 invoke 签名不同**，频道名所在的实参位置也不同（r74 反向注入时暴露）：
//   · `ctx.events.invoke(channel, payload)`        —— pluginId 已绑定，频道是**第 1 个**实参
//   · `eventBus.invoke(callerId, channel, payload)` —— 频道是**第 2 个**实参
// 首版用 `(?:"([^"]+)"|[^,)]*,\s*"([^"]+)")` 一条交替式兜两种，而交替式**总是先试第 1 个分支**，
// 于是 `eventBus.invoke("timeline", "x:y")` 会把 callerId `"timeline"` 当成频道名报出来
// （碰巧它也不是注册频道，所以看着像"抓到了"，其实报错了对象）。
// emit/send 两个对象签名一致（频道都在第 1 位），只有 invoke 需要按接收者分开。
const SEND_PLAIN_RX = new RegExp(BUS + String.raw`(emit|send)\s*(?:<[^;(]*>)?\s*\(\s*"([^"]+)"`, "g");
const SEND_INVOKE_CTX_RX = /ctx\.events\s*\??\.\s*invoke\s*(?:<[^;(]*>)?\s*\(\s*"([^"]+)"/g;
const SEND_INVOKE_BUS_RX = /eventBus\s*\??\.\s*invoke\s*(?:<[^;(]*>)?\s*\(\s*[^,)]*,\s*"([^"]+)"/g;
const RECV_RX = new RegExp(BUS + String.raw`on\s*(?:<[^;(]*>)?\s*\(\s*"([^"]+)"`, "g");

describe("事件总线 channel：注册 ⇔ 收发 双向对账", () => {
  const srcs = corpus();

  // ① 注册集（四个来源）
  const registered = new Map<string, string[]>();
  const addReg = (c: string, where: string): void => { registered.set(c, [...(registered.get(c) ?? []), where]); };
  for (const [f, s] of srcs) {
    const m = /export const channels\s*=\s*\[([\s\S]*?)\]/.exec(s);
    if (m) for (const c of m[1].matchAll(/"([^"]+)"/g)) addReg(c[1], f);
    for (const m2 of s.matchAll(/registerChannels\s*\(\s*"[\w-]+"\s*,\s*\[([\s\S]*?)\]/g)) {
      for (const c of m2[1].matchAll(/"([^"]+)"/g)) addReg(c[1], f);
    }
  }
  // ② 路由声明（keybindings 的 channel、manifest 的 revealOn）—— 框架会据此发送/订阅
  //   ⚠ `revealOn` 在 **plugin.json** 里，而 srcs 只含 .ts/.tsx（首版就这么漏了，
  //   是 ③ 的自检样本 `subagent:dialog` 当场抓出来的）。manifest 必须单独扫。
  const routed = new Set<string>();
  for (const [, s] of srcs) {
    for (const m of s.matchAll(/channel:\s*"([^"]+)"/g)) routed.add(m[1]);
  }
  for (const root of ["src/plugins", "test-plugins"]) {
    for (const f of walk(join(ROOT, root))) {
      if (!f.endsWith("plugin.json")) continue;
      const txt = readFileSync(f, "utf-8");
      for (const m of txt.matchAll(/"revealOn"\s*:\s*"([^"]+)"/g)) routed.add(m[1]);
    }
  }
  // ③ 收发
  const sent = new Map<string, string[]>();
  const received = new Map<string, string[]>();
  for (const [f, s] of srcs) {
    for (const rx of [SEND_PLAIN_RX, SEND_INVOKE_CTX_RX, SEND_INVOKE_BUS_RX]) {
      rx.lastIndex = 0;
      for (const m of s.matchAll(rx)) {
        const c = m[2] ?? m[1];
        if (c) sent.set(c, [...(sent.get(c) ?? []), f]);
      }
    }
    for (const m of s.matchAll(RECV_RX)) {
      received.set(m[1], [...(received.get(m[1]) ?? []), f]);
    }
  }
  const conventional = new Set([...registered.keys()].filter((c) => c.endsWith(":fileActionInvoke")));
  const known = new Set([...registered.keys(), ...routed, ...conventional]);

  it("判据不空转：四个注册来源都扫到了，且规模与实测一致", () => {
    // r74 实测：插件 channels 导出 15 + 壳侧 registerChannels 2 = 17
    expect(registered.size, `只扫到 ${registered.size} 个注册频道（r74 实测 17）⇒ 某个注册来源漏了`).toBeGreaterThanOrEqual(15);
    // 自检：四个来源各挑一个已知样本
    expect(registered.has("blind-review:fileActionInvoke"), "来源①（插件 channels 导出）没扫到").toBe(true);
    expect(registered.has("shell:openSettings"), "来源②（壳侧 registerChannels）没扫到 ⇒ 会把壳频道判成未注册").toBe(true);
    expect(conventional.has("blind-review:fileActionInvoke"), "来源③（约定频道）没识别出来").toBe(true);
    expect(routed.has("subagent:dialog"), "来源④（manifest revealOn）没扫到 ⇒ 会把框架订阅的频道判成死声明").toBe(true);
    expect(routed.size, "路由声明一个都没扫到").toBeGreaterThanOrEqual(5);
  });

  it("① 发送/监听的每个频道都已注册（否则运行时抛错，且只在用户走到那条路径时才炸）", () => {
    const badSend = [...sent.keys()].filter((c) => !known.has(c) && !c.startsWith("system:"));
    const badRecv = [...received.keys()].filter((c) => !known.has(c) && !c.startsWith("system:"));
    expect({ badSend, badRecv }, [
      `未注册却被发送：${badSend.join(", ") || "无"}`,
      `未注册却被监听：${badRecv.join(", ") || "无"}`,
      `      后果：EventBus 对此是**抛错**（不是静默丢），但只在用户走到那条路径时才发生`,
      `            （某个快捷键组合 / 某个文件动作 / 某个面板 revealOn）——自动化最容易漏的正是这类路径。`,
      `      修法：在发送方的 plugin.json 同目录 renderer 里 \`export const channels = [...]\` 声明它`,
      `            （框架经 plugins-host 自动注册）；若是壳自己的频道，走 eventBus.registerChannels("shell", …)。`,
      `      ⚠ 若这是**新的收发形态**（例如经变量间接传频道名），扩 SEND_RX/RECV_RX，不要加豁免。`,
    ].join("\n      ")).toEqual({ badSend: [], badRecv: [] });
  });

  it("② 注册的频道都要有人发或有人听（死声明 = 噪声，且让人以为有这条通路）", () => {
    const dead = [...registered.keys()].filter(
      (c) => !sent.has(c) && !received.has(c) && !routed.has(c) && !conventional.has(c),
    );
    expect(dead, [
      `${dead.length} 个频道注册了却既无人发也无人听：`,
      ...dead.map((c) => `      ${c}（注册于 ${(registered.get(c) ?? []).join(", ")}）`),
      `      约定频道（<pluginId>:fileActionInvoke）与 revealOn 路由已排除——它们由框架动态使用。`,
      `      修法：删掉声明；若本该有通路，补上发送方或监听方。`,
    ].join("\n")).toEqual([]);
  });

  it("③ 自检：收发判据认得全部真实形态，且**不把 transport 频道算进来**", () => {
    // 正例 1：可选链 + emit（首版 \.\s*emit 匹配不到 ?.emit）
    const sends = (code: string): string[] => {
      const out: string[] = [];
      for (const rx of [SEND_PLAIN_RX, SEND_INVOKE_CTX_RX, SEND_INVOKE_BUS_RX]) {
        rx.lastIndex = 0;
        for (const m of code.matchAll(rx)) out.push(m[2] ?? m[1]);
      }
      return out;
    };
    // 正例 1：可选链 + emit（首版 `\.\s*emit` 匹配不到 `?.emit`）
    expect(sends('ctx.events?.emit("subagent:dialog");'), "自检失败：?.emit 形态没被认出来").toEqual(["subagent:dialog"]);
    // 正例 2：ctx.events.invoke —— 频道是**第 1 个**实参
    expect(sends('ctx.events.invoke("timeline:focusComposer", {});'), "自检失败：ctx.events.invoke 的频道应在第 1 位").toEqual(["timeline:focusComposer"]);
    // 正例 3：eventBus.invoke —— 频道是**第 2 个**实参（首版会把 callerId 当成频道）
    expect(sends('eventBus.invoke("timeline", "blind-review:fileActionInvoke", p);'),
      "自检失败：eventBus.invoke 的频道在第 2 位，不得把 callerId 当成频道").toEqual(["blind-review:fileActionInvoke"]);
    // 正例 4：eventBus.emit
    expect(sends('eventBus.emit("plugin:x", {});')).toEqual(["plugin:x"]);
    // ⚠ 反例：**transport 的频道不得被算成事件总线频道**（两套名字空间）。
    //   首版按任意 .on("…") 匹配，把 transport.on("session:event") 等 17 个 WS 频道
    //   全算成"监听了但未注册"，是本轮最大的一批假阳性。
    expect(RECV_RX.test('transport.on("session:event", listener);'), "自检失败：transport 频道被当成事件总线频道 ⇒ 会产假阳性").toBe(false);
    RECV_RX.lastIndex = 0;
    expect(RECV_RX.test('ctx.events.on("timeline:focusComposer", (p) => {});'), "自检失败：真实的 ctx.events.on 没被认出来").toBe(true);
    RECV_RX.lastIndex = 0;
    // 反例：普通对象上的 .emit（例如 EventEmitter 的本地实例）也不该算
    expect(sends('this.emitter.emit("local:thing");'), "自检失败：非事件总线对象的 emit 被算进来了").toEqual([]);
  });
});
