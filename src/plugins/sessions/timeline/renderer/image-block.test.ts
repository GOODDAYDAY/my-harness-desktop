// image-block 的 mimeOf：内部兜底表 + 契约字段（扩展名）的表外取值断言（r245；按 r241/r242 的通则）。
//
// ## 钉的性质
//
// 扩展名来自**任意附件文件**（契约字段），IMAGE_MIME 只有 5 项（png/jpg/jpeg/gif/webp）。
// 表外取值必然出现 ⇒ 必须回落而不是崩、也不是产出空串（空 mime 会让 <img> 的 data URI 失效，
// 表现为"图片裂开"，而且不报错——典型的静默失败）。
//
// ① 表内 5 种各自映射正确（jpeg 与 jpg 同值——两种写法都是真实世界里出现的）；
// ② **表外扩展名** ⇒ 回落 image/png（不是空串、不是 undefined、不抛）；
// ③ 无扩展名（没有点）⇒ 回落 image/png；
// ④ 大写扩展名 ⇒ 与 lowercase 同结果（判据里已 toLowerCase，钉住它不被改坏）；
// ⑤ 多个点（如 a.b.png）⇒ 取**最后一段**；
// ⑥ 空串 / 只有点 ⇒ 不抛，仍给出可用 mime。

import { describe, it, expect } from "vitest";
import { mimeOf } from "./image-block";

describe("mimeOf：表外扩展名要回落，不能崩也不能给空 mime", () => {
  it("① 表内 5 种映射正确（jpg 与 jpeg 同值）", () => {
    expect(mimeOf("/a/x.png")).toBe("image/png");
    expect(mimeOf("/a/x.jpg")).toBe("image/jpeg");
    expect(mimeOf("/a/x.jpeg")).toBe("image/jpeg");
    expect(mimeOf("/a/x.gif")).toBe("image/gif");
    expect(mimeOf("/a/x.webp")).toBe("image/webp");
  });

  it("② 表外扩展名 ⇒ 回落 image/png（不是空串/undefined，也不抛）", () => {
    for (const src of ["/a/x.tiff", "/a/x.bmp", "/a/x.avif", "/a/x.svg", "/a/x.heic"]) {
      const got = mimeOf(src);
      expect(got, `${src} 要回落到可用的 mime`).toBe("image/png");
      expect(got.length, "mime 不能是空串（空 mime 会让 data URI 失效 ⇒ 图片静默裂开）").toBeGreaterThan(0);
    }
  });

  it("③ 无扩展名（没有点）⇒ 回落 image/png", () => {
    expect(mimeOf("/a/noextension")).toBe("image/png");
  });

  it("④ 大写扩展名与 lowercase 同结果（toLowerCase 不能被改坏）", () => {
    expect(mimeOf("/a/x.PNG")).toBe("image/png");
    expect(mimeOf("/a/x.JPG")).toBe("image/jpeg");
    expect(mimeOf("/a/x.TIFF")).toBe("image/png");
  });

  it("⑤ 多个点 ⇒ 取最后一段（lastIndexOf 的语义）", () => {
    expect(mimeOf("/a/archive.tar.png")).toBe("image/png");
    expect(mimeOf("/a/archive.png.tar")).toBe("image/png");   // 最后一段 tar 是表外 ⇒ 回落
  });

  it("⑥ 空串 / 只有点 ⇒ 不抛，仍给出可用 mime", () => {
    expect(() => mimeOf("")).not.toThrow();
    expect(mimeOf("")).toBe("image/png");
    expect(() => mimeOf(".")).not.toThrow();
    expect(mimeOf(".").length).toBeGreaterThan(0);
  });
});
