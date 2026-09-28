import { describe, it, expect } from "vitest";
import { classifyReferenceFile, isReferenceableFile , partitionReferenceFiles } from "./composer-files";

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

// ─────────────────────────────────────────────────────────────────────────────
// partitionReferenceFiles（r144 从 timeline 的 ingestFiles 抽出的纯函数）
//
// 抽出的动机是**可测性**：原先这 14 行内联在 1400 行组件里，要测就得渲染整个 timeline。
// 按 §4.5 把唯一的外层依赖（取绝对路径）作为参数注入后，分流逻辑可以裸单测。
//
// ⚠ 按 r141/r143 的纪律**覆盖两侧**：全收 / 全拒 / **混合**（最容易漏的一种）/ 空输入；
//   以及路径回落（宿主没有 getPathForFile 时）。
// ─────────────────────────────────────────────────────────────────────────────
describe("partitionReferenceFiles：拖拽/粘贴的分流（收 vs 拒）", () => {
  const withPath = (f: { name: string }): string => `/abs/${f.name}`;
  const noPath = (): undefined => undefined;   // 浏览器宿主：没有 mhdFile 能力

  it("① 全部可参考 ⇒ 全收、零拒收，且**保持输入顺序**", () => {
    const r = partitionReferenceFiles(
      [{ name: "a.ts" }, { name: "shot.png" }, { name: "README" }], withPath);
    expect(r.rejectedCount).toBe(0);
    expect(r.accepted.map((x) => x.name)).toEqual(["a.ts", "shot.png", "README"]);
    expect(r.accepted.map((x) => x.path)).toEqual(["/abs/a.ts", "/abs/shot.png", "/abs/README"]);
  });

  it("② 全部不可参考 ⇒ 零收、拒收数正确（调用方据此弹提示，§7.6 不许静默丢弃）", () => {
    const r = partitionReferenceFiles([{ name: "movie.mp4" }, { name: "app.exe" }], withPath);
    expect(r.accepted).toEqual([]);
    expect(r.rejectedCount).toBe(2);
  });

  it("③ **混合**（最真实的拖拽情形）⇒ 两件事同时成立：收下的进清单、拒收的计数", () => {
    const r = partitionReferenceFiles(
      [{ name: "a.ts" }, { name: "movie.mp4" }, { name: "b.md" }, { name: "app.exe" }, { name: "c.zip" }],
      withPath);
    expect(r.accepted.map((x) => x.name), "只收可参考的三个，且顺序不变").toEqual(["a.ts", "b.md"]);
    expect(r.rejectedCount, "mp4/exe/zip 三个被拒").toBe(3);
  });

  it("④ 宿主取不到绝对路径 ⇒ **回落成文件名**（而不是丢掉整个文件）", () => {
    const r = partitionReferenceFiles([{ name: "a.ts" }], noPath);
    expect(r.accepted).toEqual([{ path: "a.ts", name: "a.ts" }]);
    expect(r.rejectedCount, "回落不算拒收——文件仍然带上了，只是按名字引用").toBe(0);
  });

  it("⑤ 空输入 ⇒ 空结果，不报错（拖了个空 dataTransfer 不该弹提示）", () => {
    expect(partitionReferenceFiles([], withPath)).toEqual({ accepted: [], rejectedCount: 0 });
  });

  it("⑥ 带路径段的文件名（拖进来的是完整路径）⇒ 分类按 basename 判，不按整串", () => {
    const r = partitionReferenceFiles(
      [{ name: "/Users/x/proj/movie.mp4" }, { name: "C:\\proj\\notes.md" }], withPath);
    expect(r.accepted.map((x) => x.name), "mp4 按 basename 也该被拒").toEqual(["C:\\proj\\notes.md"]);
    expect(r.rejectedCount).toBe(1);
  });

  it("⑦ 反证：拒收数不是恒 0、收单也不是恒空（防『总是收』/『总是拒』的实现骗过①②）", () => {
    expect(partitionReferenceFiles([{ name: "a.ts" }], withPath).rejectedCount).toBe(0);
    expect(partitionReferenceFiles([{ name: "a.exe" }], withPath).accepted).toEqual([]);
    expect(partitionReferenceFiles([{ name: "a.exe" }], withPath).rejectedCount).toBe(1);
  });
});
