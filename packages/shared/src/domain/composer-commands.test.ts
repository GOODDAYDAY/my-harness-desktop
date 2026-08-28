// composer-commands 纯解析单测(圆心:契约 + 纯函数)。
import { describe, it, expect } from "vitest";
import { parseComposerCommandText, matchComposerCommand, type ComposerCommand } from "./composer-commands";

describe("parseComposerCommandText", () => {
  it("解析命令头与全文 rest(多行保留)", () => {
    expect(parseComposerCommandText("/goal 写 README")).toEqual({ name: "goal", rest: "写 README" });
    expect(parseComposerCommandText("/goal 第一行\n第二行")).toEqual({ name: "goal", rest: "第一行\n第二行" });
    expect(parseComposerCommandText("/goal")).toEqual({ name: "goal", rest: "" });
    expect(parseComposerCommandText("/goal   ")).toEqual({ name: "goal", rest: "" });
  });

  it("非命令文本 → null", () => {
    expect(parseComposerCommandText("普通消息")).toBeNull();
    expect(parseComposerCommandText("")).toBeNull();
    expect(parseComposerCommandText("/")).toBeNull();
    expect(parseComposerCommandText("//x")).toBeNull();
  });
});

describe("matchComposerCommand", () => {
  const cmds: ComposerCommand[] = [
    { name: "goal", handle: () => true },
    { name: "Note", handle: () => false },
  ];

  it("按名字大小写不敏感命中", () => {
    expect(matchComposerCommand("/GOAL x", cmds)?.name).toBe("goal");
    expect(matchComposerCommand("/note x", cmds)?.name).toBe("Note");
  });

  it("名字必须整词匹配:/goalx 不命中 goal", () => {
    expect(matchComposerCommand("/goalx x", cmds)).toBeNull();
  });

  it("无命中 / 非命令 → null", () => {
    expect(matchComposerCommand("/unknown x", cmds)).toBeNull();
    expect(matchComposerCommand("普通消息", cmds)).toBeNull();
  });
});
