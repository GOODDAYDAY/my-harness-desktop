import { describe, it, expect } from "vitest";
import { classifyReferenceFile, isReferenceableFile } from "./composer-files";

describe("classifyReferenceFile", () => {
  it("文本/代码扩展名 → file", () => {
    expect(classifyReferenceFile("src/a.ts")).toBe("file");
    expect(classifyReferenceFile("README.md")).toBe("file");
    expect(classifyReferenceFile("config.json")).toBe("file");
    expect(classifyReferenceFile("main.py")).toBe("file");
    expect(classifyReferenceFile("App.tsx")).toBe("file");
    expect(classifyReferenceFile("C:\\a\\b.go")).toBe("file");
  });

  it("图片扩展名 → image", () => {
    expect(classifyReferenceFile("a.png")).toBe("image");
    expect(classifyReferenceFile("b.JPEG")).toBe("image");
    expect(classifyReferenceFile("c.webp")).toBe("image");
    expect(classifyReferenceFile("d.svg")).toBe("file"); // svg 是 XML 文本,按文件引用
  });

  it("无扩展名已知名 → file", () => {
    expect(classifyReferenceFile("Makefile")).toBe("file");
    expect(classifyReferenceFile("Dockerfile")).toBe("file");
    expect(classifyReferenceFile("README")).toBe("file");
    expect(classifyReferenceFile("LICENSE")).toBe("file");
  });

  it("点文件 → file", () => {
    expect(classifyReferenceFile(".gitignore")).toBe("file");
    expect(classifyReferenceFile(".env")).toBe("file");
    expect(classifyReferenceFile(".editorconfig")).toBe("file");
  });

  it("二进制/未知 → null", () => {
    expect(classifyReferenceFile("a.zip")).toBeNull();
    expect(classifyReferenceFile("a.exe")).toBeNull();
    expect(classifyReferenceFile("a.pdf")).toBeNull();
    expect(classifyReferenceFile("a")).toBeNull();
    expect(classifyReferenceFile("")).toBeNull();
  });

  it("isReferenceableFile 与 classifyReferenceFile 一致", () => {
    expect(isReferenceableFile("a.ts")).toBe(true);
    expect(isReferenceableFile("a.png")).toBe(true);
    expect(isReferenceableFile("a.zip")).toBe(false);
  });
});
