import { describe, it, expect } from "vitest";
import { pathBasename } from "./path-utils";

describe("pathBasename", () => {
  it("POSIX 路径取末段", () => {
    expect(pathBasename("/home/user/project")).toBe("project");
    expect(pathBasename("usr/bin/env")).toBe("env");
  });

  it("Windows 盘符路径取末段(核心修复:分隔符是 \\ 而非 /)", () => {
    expect(pathBasename("D:\\git-project\\pi-desktop")).toBe("pi-desktop");
    expect(pathBasename("C:\\Users\\me\\AppData")).toBe("AppData");
    expect(pathBasename("D:\\a\\b\\c")).toBe("c");
  });

  it("UNC 路径取末段", () => {
    expect(pathBasename("\\\\server\\share\\dir")).toBe("dir");
  });

  it("尾部分隔符被忽略(等价旧实现 split('/').filter(Boolean) 的去空段语义)", () => {
    expect(pathBasename("/home/user/proj/")).toBe("proj");
    expect(pathBasename("D:\\a\\b\\")).toBe("b");
  });

  it("混合分隔符(如 Windows 下 git 输出的正斜杠相对路径)同样取末段", () => {
    expect(pathBasename("D:/git-project/pi-desktop")).toBe("pi-desktop");
    expect(pathBasename("src/plugins/project/projects/renderer")).toBe("renderer");
  });

  it("退化输入回退原串", () => {
    expect(pathBasename("")).toBe("");
    expect(pathBasename("/")).toBe("/");
    expect(pathBasename("\\")).toBe("\\");
  });
});
