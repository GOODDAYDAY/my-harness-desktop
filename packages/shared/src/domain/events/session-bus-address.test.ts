// 总线**地址方案**的判定与提取（r147；这 5 个纯函数此前零测试引用）。
//
// ## 为什么值得测（它们看起来太简单）
//
// 它们是 renderer 侧总线路由的基础：`isSessionAddress` / `isChannelAddress` / `isPluginAddress`
// 决定一条消息投给"某个会话"还是"某个频道房"还是"某个插件"，
// `sessionKeyOf` / `channelNameOf` 从地址里取回 procs key / 房名。
// 简单不等于不会错——**错一个就投错频道**，而这类错误在 UI 上表现为"消息没到"，极难归因。
//
// ## 被测的两类性质
//
// ① **三种前缀互斥**：一个地址只可能属于一类。若某天有人把 `isChannelAddress` 写成
//    `startsWith("c")` 之类，"channel:" 与别的 c 开头地址就会同时命中两类。
// ② **提取器的危险边界**：`sessionKeyOf` 是裸 `slice(8)`，对**非 session 地址不报错**——
//    `sessionKeyOf("channel:x")` 会静默返回 `"x"`（把房名当成了会话 key）。
//    本测试把当前行为**钉住并写明危险**，不是为它背书：调用方必须先判定再提取。
//    （若将来要改成抛错，这条测试会红，那时是**有意识地**改契约。）

import { describe, it, expect } from "vitest";
import {
  isSessionAddress, isChannelAddress, isPluginAddress, sessionKeyOf, channelNameOf,
} from "./session-bus";

describe("总线地址：三种前缀的判定互斥", () => {
  const CASES: Array<[string, [boolean, boolean, boolean]]> = [
    //                        session  channel  plugin
    ["session:proj/a.jsonl", [true, false, false]],
    ["channel:stickers:send", [false, true, false]],
    ["plugin:goal", [false, false, true]],
    ["", [false, false, false]],
    ["sessions:x", [false, false, false]],      // 前缀相似但不是（复数）
    ["channelx:y", [false, false, false]],      // 少了冒号
    ["Session:x", [false, false, false]],       // 大小写敏感（地址是内部标识，不做归一）
  ];
  for (const [addr, [s, c, p]] of CASES) {
    it(`『${addr || "(空串)"}』⇒ session=${s} channel=${c} plugin=${p}`, () => {
      expect(isSessionAddress(addr)).toBe(s);
      expect(isChannelAddress(addr)).toBe(c);
      expect(isPluginAddress(addr)).toBe(p);
      // 互斥：至多一类为真
      expect([s, c, p].filter(Boolean).length, "一个地址不该同时属于两类").toBeLessThanOrEqual(1);
    });
  }
});

describe("总线地址：提取器（含危险边界的钉桩）", () => {
  it("① sessionKeyOf 往返：session:<key> → <key>（key 里可以含冒号与斜杠）", () => {
    expect(sessionKeyOf("session:proj/a.jsonl")).toBe("proj/a.jsonl");
    expect(sessionKeyOf("session:a:b:c")).toBe("a:b:c");   // 只切掉第一段前缀，不按冒号分割
  });

  it("② channelNameOf 往返：channel:<name> → <name>", () => {
    expect(channelNameOf("channel:stickers:send")).toBe("stickers:send");
  });

  it("③ 空尾巴：正好是前缀本身 ⇒ 返回空串（不抛、不返回 undefined）", () => {
    expect(sessionKeyOf("session:")).toBe("");
    expect(channelNameOf("channel:")).toBe("");
  });

  it("④ **危险边界钉桩**：提取器不校验前缀，喂错地址会静默返回垃圾", () => {
    // 这不是"期望的行为"，是**当前契约的事实**：调用方必须先 is*Address 判定再提取。
    // 钉住它的目的是——将来若把提取器改成抛错/返回 null（更安全），这条会红，
    // 那时是**有意识地**改契约，而不是某次重构顺手改掉、无人察觉。
    expect(sessionKeyOf("channel:x")).toBe("x");     // "channel:x".slice(8) —— 房名被当成了会话 key
    expect(channelNameOf("session:abc")).toBe("abc");
    expect(sessionKeyOf("")).toBe("");               // 短于前缀也不抛（slice 的语义）
  });
});
