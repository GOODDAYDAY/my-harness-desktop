// parseGoalCommand 单测 —— 人类 /goal 命令的纯解析(与模型工具互补的那一半)。
import { describe, it, expect } from "vitest";
import { GOAL_COMMAND_NAME, parseGoalCommand } from "./goal-state";

describe("parseGoalCommand(人类 /goal 命令解析)", () => {
  it("命令名注册为 goal", () => {
    expect(GOAL_COMMAND_NAME).toBe("goal");
  });

  it("/goal <目标> → set(多行目标保留全文)", () => {
    expect(parseGoalCommand("/goal 写完 README")).toEqual({
      kind: "set",
      request: { objective: "写完 README" },
    });
    expect(parseGoalCommand("/goal 第一行\n第二行")).toEqual({
      kind: "set",
      request: { objective: "第一行\n第二行" },
    });
  });

  it("目标两端空白被规范化", () => {
    expect(parseGoalCommand("/goal   带空白的目标   ")).toEqual({
      kind: "set",
      request: { objective: "带空白的目标" },
    });
  });

  it("命令名大小写不敏感;/goalx 不误匹配", () => {
    expect(parseGoalCommand("/GOAL 大写命令")?.kind).toBe("set");
    expect(parseGoalCommand("/Goal 混合大小写")?.kind).toBe("set");
    expect(parseGoalCommand("/goalx 不是 goal")).toBeNull();
    expect(parseGoalCommand("/goal-set 也不是")).toBeNull();
  });

  it("裸 /goal → status", () => {
    expect(parseGoalCommand("/goal")).toEqual({ kind: "status" });
    expect(parseGoalCommand("/goal   ")).toEqual({ kind: "status" });
  });

  it("stop/pause 子命令(大小写不敏感)", () => {
    expect(parseGoalCommand("/goal stop")).toEqual({ kind: "pause" });
    expect(parseGoalCommand("/goal PAUSE")).toEqual({ kind: "pause" });
  });

  it("resume/start/continue 子命令", () => {
    expect(parseGoalCommand("/goal resume")).toEqual({ kind: "resume" });
    expect(parseGoalCommand("/goal start")).toEqual({ kind: "resume" });
    expect(parseGoalCommand("/goal CONTINUE")).toEqual({ kind: "resume" });
  });

  it("clear/rm/delete 子命令", () => {
    expect(parseGoalCommand("/goal clear")).toEqual({ kind: "clear" });
    expect(parseGoalCommand("/goal rm")).toEqual({ kind: "clear" });
    expect(parseGoalCommand("/goal DELETE")).toEqual({ kind: "clear" });
  });

  it("edit <新目标> → edit;裸 edit 降级 status(不把 'edit' 误当目标)", () => {
    expect(parseGoalCommand("/goal edit 改后的目标")).toEqual({
      kind: "edit",
      objective: "改后的目标",
    });
    expect(parseGoalCommand("/goal edit")).toEqual({ kind: "status" });
    expect(parseGoalCommand("/goal edit    ")).toEqual({ kind: "status" });
  });

  it("子命令必须是独立单词:以子命令开头的长短语按目标处理", () => {
    // "stop the server 优化" 是目标文案,不是暂停指令——单词精确命中才算子命令。
    expect(parseGoalCommand("/goal stop the server 优化")).toEqual({
      kind: "set",
      request: { objective: "stop the server 优化" },
    });
  });

  it("非 /goal 输入 → null(放行)", () => {
    expect(parseGoalCommand("普通消息")).toBeNull();
    expect(parseGoalCommand("/compact")).toBeNull();
    expect(parseGoalCommand("")).toBeNull();
  });
});
