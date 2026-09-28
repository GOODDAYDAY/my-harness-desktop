// 设置页「配置文件归属」判定的单测 —— 分层空间 vs 内核自留地。
//
// 为什么值得单测：这三个函数是**纯函数**（路径进、布尔/字符串出，无 IO、无 React），
// 按 CLAUDE.md §4.5 的判据就是内层材料；而它们决定的行为很实在——
// 判错会让壳去读写一个**错误的分层路径**（症状是"设置改了不生效/写进了奇怪的文件"，很难查）。
//
// r32 修的缺陷：原判据是 `configFile.startsWith("~/.pi/agent/") || startsWith("~/.dsh/")`
// ——① 壳里写死内核身份（加内核要改这里）；② **对第三个内核就是错的**：
// `~/.minimal/agent/config.json` 不在两个前缀里 → 被判成分层项 → `relPathOf` 用
// `slice(DESKTOP_PREFIX.length)` 切一个不以该前缀开头的路径，得到垃圾（实测 `'g.json'`）。
// 现改为中性判据：**只有壳自己的配置空间 `~/.my-harness-desktop/` 才分层，其余一律扁平**。

import { describe, it, expect } from "vitest";
import { isOutsideLayeredSpace, effectiveConfigFile, relPathOf } from "./settings-page";

const DESKTOP = "~/.my-harness-desktop/";

describe("isOutsideLayeredSpace：内核自留地一律扁平，壳的配置空间才分层", () => {
  it("壳自己的配置空间 → 分层（可两层合并、显示分层按钮）", () => {
    expect(isOutsideLayeredSpace(`${DESKTOP}config/theme-manager.json`)).toBe(false);
    expect(isOutsideLayeredSpace(`${DESKTOP}config/x.json`)).toBe(false);
  });

  it("已知内核的自留地 → 扁平", () => {
    expect(isOutsideLayeredSpace("~/.pi/agent/settings.json")).toBe(true);
    expect(isOutsideLayeredSpace("~/.pi/agent/models.json")).toBe(true);
    expect(isOutsideLayeredSpace("~/.dsh/settings.yaml")).toBe(true);
    expect(isOutsideLayeredSpace("~/.dsh/cordis.yml")).toBe(true);
  });

  it("★ 第三个/第四个内核的自留地 → **同样扁平**（判据不点名内核，加内核无需改这里）", () => {
    // 这条是 r32 那个潜在 bug 的回归锚：旧判据对下面每一个都返回 false（= 误判成分层项），
    // 于是 relPathOf 会切出垃圾 relPath、壳去读写错误的分层路径。
    expect(isOutsideLayeredSpace("~/.minimal/agent/config.json")).toBe(true);
    expect(isOutsideLayeredSpace("~/.minimal/agent/models.json")).toBe(true);
    expect(isOutsideLayeredSpace("~/.fourth-kernel/conf/settings.json")).toBe(true);
    expect(isOutsideLayeredSpace("/abs/path/to/some/kernel/settings.json")).toBe(true);
  });

  it("空串按扁平处理（不是壳空间里的路径就不该走分层合并）", () => {
    expect(isOutsideLayeredSpace("")).toBe(true);
  });
});

describe("effectiveConfigFile：零声明的 framework 项按 pluginId 推统一通道路径", () => {
  it("未声明 configFile → 落到壳的分层空间（因此是可分层的）", () => {
    const f = effectiveConfigFile({ id: "x", pluginId: "my-plugin" } as never);
    expect(f).toBe(`${DESKTOP}config/my-plugin.json`);
    expect(isOutsideLayeredSpace(f), "推出来的路径应当在分层空间内").toBe(false);
  });

  it("已声明 configFile → 原样用（内核自留地就保持扁平）", () => {
    const f = effectiveConfigFile({ id: "x", pluginId: "p", configFile: "~/.minimal/agent/config.json" } as never);
    expect(f).toBe("~/.minimal/agent/config.json");
    expect(isOutsideLayeredSpace(f)).toBe(true);
  });
});

describe("relPathOf：只在分层空间内有意义，且必须与 isOutsideLayeredSpace 配套使用", () => {
  it("壳空间内的路径 → 正确的相对路径（项目级 = <cwd>/.my-harness-desktop/<rel>）", () => {
    expect(relPathOf(`${DESKTOP}config/theme-manager.json`)).toBe("config/theme-manager.json");
  });

  it("★ 对**非**壳空间的路径调用 relPathOf 会得到垃圾 —— 所以调用前必须先过 isOutsideLayeredSpace", () => {
    // 这条不是鼓励这种用法，而是把"为什么必须先判"写成可执行的事实：
    // 旧的 isBaseFile 对 minimal 返回 false，于是这里的垃圾值会被真的拿去读写。
    const garbage = relPathOf("~/.minimal/agent/config.json");
    expect(garbage).not.toBe("agent/config.json");
    expect(garbage.length, "切出来的东西比原路径短得多，显然是垃圾").toBeLessThan(12);
    expect(isOutsideLayeredSpace("~/.minimal/agent/config.json"), "配套判据必须先把它挡在分层分支之外").toBe(true);
  });
});
