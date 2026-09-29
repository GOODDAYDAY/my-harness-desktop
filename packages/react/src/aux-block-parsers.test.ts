// aux-block-parsers 注册表（r250；消化发布面零测试引用清单里的 getAuxParsers）。
//
// ## 钉的性质
//
// 这个注册表是 renderer 侧的**插件贡献面**：plugins-host 加载插件 module 时收集
// `mod.auxParsers` 注册进来，timeline 的 blocks.ts 经 `getAuxParsers()` 拿全部解析器
// 喂 `parseUserBlocks`；卸载插件时按 id 清理（头注：残留的解析器无害但不该留）。
//
// ① 注册后 `getAuxParsers()` 能拿到（消费方唯一入口）；
// ② **同 id 再注册是替换、不是追加**（热重载/同插件二次加载时不该出现两份解析器——
//    两份会让同一块文本被解析两次，表现为"块重复渲染"）；
// ③ 不同 id 是追加；
// ④ `unregisterAuxParsers` 按 id 精确清理，不误删别的；
// ⑤ 清理不存在的 id 不抛、不影响其它条目。
//
// ⚠ 注册表是模块级单例 ⇒ 每例前后要清场（用 unregister 把本测试注册的 id 全清），
//   否则"谁先跑"会决定结果（r155 的教训：测单例要防互相污染）。

import { describe, it, expect, afterEach } from "vitest";
import type { AuxBlockParser } from "@my-harness-desktop/shared";
import { registerAuxParsers, unregisterAuxParsers, getAuxParsers } from "./aux-block-parsers";

const IDS = ["r250-a", "r250-b", "r250-c"];
function mk(id: string, tag: string): AuxBlockParser {
  return { id, fence: tag, parse: (body: string) => ({ kind: tag, body }) } as unknown as AuxBlockParser;
}
afterEach(() => { unregisterAuxParsers(IDS); });

const ids = () => getAuxParsers().map((p) => p.id);

describe("aux-block-parsers：注册表的替换/追加/精确清理", () => {
  it("① 注册后 getAuxParsers 能拿到（消费方唯一入口）", () => {
    registerAuxParsers([mk("r250-a", "alpha")]);
    expect(ids()).toContain("r250-a");
  });

  it("② 同 id 再注册是**替换**不是追加（热重载不该出现两份解析器）", () => {
    registerAuxParsers([mk("r250-a", "alpha")]);
    registerAuxParsers([mk("r250-a", "alpha-v2")]);
    const mine = getAuxParsers().filter((p) => p.id === "r250-a");
    expect(mine, "同 id 只能有一份（两份会让同一块文本被解析两次 ⇒ 块重复渲染）").toHaveLength(1);
    expect((mine[0] as unknown as { fence: string }).fence, "留下的应是后注册的那份").toBe("alpha-v2");
  });

  it("③ 不同 id 是追加", () => {
    registerAuxParsers([mk("r250-a", "alpha"), mk("r250-b", "beta")]);
    expect(ids()).toContain("r250-a");
    expect(ids()).toContain("r250-b");
  });

  it("④ unregister 按 id 精确清理，不误删别的", () => {
    registerAuxParsers([mk("r250-a", "alpha"), mk("r250-b", "beta"), mk("r250-c", "gamma")]);
    unregisterAuxParsers(["r250-b"]);
    expect(ids()).toContain("r250-a");
    expect(ids()).not.toContain("r250-b");
    expect(ids(), "不该误删同批的其它条目").toContain("r250-c");
  });

  it("⑤ 清理不存在的 id 不抛、不影响其它条目", () => {
    registerAuxParsers([mk("r250-a", "alpha")]);
    expect(() => unregisterAuxParsers(["r250-never-registered"])).not.toThrow();
    expect(ids()).toContain("r250-a");
  });
});
