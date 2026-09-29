// 工具限制注入文本的**构造 ⇄ 剥除**往返（r151；此前零测试引用，而它是发布面导出）。
//
// ## 为什么这对函数必须成对测
//
// `buildToolLimitNote` 把"本次会话限制了哪些工具"拼成一段**协议指令**注入到发往内核的文本前面
// （`session-store.ts:640`：`finalText = buildToolLimitNote(...) + "\n\n" + text`）；
// `stripToolLimitNote` 在渲染用户气泡时把它剥掉（用户不该看到这段系统指令）。
// 两者靠一个**共享前缀常量**与一个**"\n\n" 分隔约定**耦合——
// 任何一侧改了格式而另一侧没跟上，后果是二选一：
//   · 剥不掉 ⇒ 用户在气泡里看到「[System] 本次会话已限制可用工具…」这段内部指令；
//   · 剥过头 ⇒ 用户的真实消息被吃掉一部分。
// 这两种都是**静默**的（不报错、只是显示不对），所以必须用往返测试钉住。
//
// ⚠ 注释里写明它是**协议指令而非 UI 文案**（勿 i18n、勿当界面文案改），
//   所以测试断言的是**结构性质**（前缀/分隔/往返），不是逐字文案——
//   逐字断言会让"改文案"与"改协议"看起来一样危险，反而掩盖真正的风险。

import { describe, it, expect } from "vitest";
import { buildToolLimitNote, stripToolLimitNote } from "./session-store";

describe("buildToolLimitNote / stripToolLimitNote：注入 ⇄ 剥除的往返", () => {
  it("① 往返：注入后剥除，拿回**原样**的用户文本（含多行与空行）", () => {
    for (const user of ["帮我修登录", "第一行\n第二行", "带\n\n空行的消息", ""]) {
      const injected = `${buildToolLimitNote(["bash", "read"])}\n\n${user}`;
      expect(stripToolLimitNote(injected), `用户文本『${user.slice(0, 10)}』应原样拿回`).toBe(user);
    }
  });

  it("② 空清单 = **全禁**（显式语义，不是缺省）：注入文本要传达『无可用工具』", () => {
    const note = buildToolLimitNote([]);
    expect(note).toContain("无");
    expect(note, "空清单不该渲染成『可用工具: 』（那读起来像漏了列表）").not.toMatch(/可用工具: *$/m);
  });

  it("③ 多工具 ⇒ 全部列出（漏一个内核就可能少用一个工具）", () => {
    const note = buildToolLimitNote(["bash", "read", "write"]);
    for (const t of ["bash", "read", "write"]) expect(note).toContain(t);
  });

  it("④ **不含前缀的文本原样返回**（不该误剥用户自己的消息）", () => {
    for (const plain of ["普通消息", "[System] 用户自己写的开头", ""]) {
      expect(stripToolLimitNote(plain)).toBe(plain);
    }
  });

  it("⑤ 只有注入头、没有分隔符 ⇒ 剥成空串（不把半个指令留给用户看）", () => {
    expect(stripToolLimitNote(buildToolLimitNote(["bash"]))).toBe("");
  });

  it("⑥ 钉桩：分隔约定是**首个** \\n\\n（用户消息里再有 \\n\\n 也不受影响）", () => {
    const user = "第一段\n\n第二段";
    const injected = `${buildToolLimitNote(["bash"])}\n\n${user}`;
    expect(stripToolLimitNote(injected)).toBe(user);   // 只剥到第一个 \n\n 为止
  });
});
