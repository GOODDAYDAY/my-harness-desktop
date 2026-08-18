// stickers-store 的 zip 导入导出运行时验证:exportStickersZip 的 files 组装
// (stickers.json manifest + banners/ 图文件)与 importStickersZip 的还原(逐条建贴纸)。
// mock ctx(config/configFile/dialog),不碰真实文件系统。
import { describe, it, expect } from "vitest";
import type { PluginContext } from "@my-harness-desktop/contract";
import {
  exportStickersZip, importStickersZip, loadStickers, moveToLayer, removeSticker, reorderStickers,
} from "./stickers-store";

type MockCtx = Pick<PluginContext, "config" | "configFile" | "dialog">;

function makeCtx(over: Partial<MockCtx> = {}): MockCtx {
  return {
    config: {
      getScope: async (scope: "global" | "project") => {
        if (scope === "project") {
          return { stickers: [{ id: "a", title: "标题", content: "内容", banner: "~/.my-harness-desktop/s/a.png", order: 0, createdAt: 1, updatedAt: 1 }] };
        }
        return {};
      },
      set: async () => {},
      get: async () => undefined,
      all: async () => ({}),
    },
    configFile: {
      readBinary: async () => "aGVsbG8=",
      append: async () => {},
      get: async () => ({}),
      writeBinary: async () => {},
    },
    dialog: {
      openDirectory: async () => null,
      openImages: async () => [],
      openTextFile: async () => null,
      saveTextFile: async () => null,
      writeImages: async () => 0,
      openFile: async () => {},
      saveZip: async () => null,
      openZip: async () => null,
    },
    ...over,
  } as unknown as MockCtx;
}

describe("exportStickersZip", () => {
  it("组装 stickers.json manifest + banners/ 图文件,传给 saveZip", async () => {
    let saved: { files: { name: string; base64: string }[]; defaultFileName?: string } | null = null;
    const ctx = makeCtx({
      dialog: {
        ...makeCtx().dialog,
        saveZip: async (opts) => { saved = opts; return "/tmp/x.zip"; },
      } as MockCtx["dialog"],
    });
    const path = await exportStickersZip(ctx);
    expect(path).toBe("/tmp/x.zip");
    expect(saved).not.toBeNull();
    expect(saved!.files.length).toBe(2);
    expect(saved!.files[0].name).toBe("stickers.json");
    const manifest = JSON.parse(Buffer.from(saved!.files[0].base64, "base64").toString("utf-8"));
    expect(manifest.stickers).toHaveLength(1);
    expect(manifest.stickers[0]).toMatchObject({ title: "标题", content: "内容", layer: "project", banner: "banners/a.png" });
    expect(saved!.files[1].name).toBe("banners/a.png");
    expect(saved!.defaultFileName).toContain("stickers-");
  });
});

describe("importStickersZip", () => {
  it("解包 manifest + banners/,逐条建贴纸(写 banner 文件)", async () => {
    const created: { title?: string; content: string; banner?: { base64: string; mimeType: string } }[] = [];
    const written: { path: string; base64: string }[] = [];
    const ctx = makeCtx({
      configFile: {
        readBinary: async () => "aGVsbG8=",
        append: async () => {},
        get: async () => ({}),
        writeBinary: async (path, base64) => { written.push({ path, base64 }); },
      },
      dialog: {
        ...makeCtx().dialog,
        openZip: async () => ({
          name: "pack.zip",
          files: [
            { name: "stickers.json", base64: Buffer.from(JSON.stringify({ stickers: [{ title: "T", content: "C", layer: "global", banner: "banners/b.png" }] })).toString("base64") },
            { name: "banners/b.png", base64: "aGVsbG8=" },
          ],
        }),
      } as MockCtx["dialog"],
    });
    // 捕获 createSticker 的写层行为:写全局层时 set 被调
    const sets: { key: string; scope: string }[] = [];
    (ctx as unknown as { config: { set: (k: string, v: unknown, o?: { scope?: string }) => Promise<void> } }).config.set = async (k, _v, o) => {
      sets.push({ key: k, scope: o?.scope ?? "project" });
    };
    const res = await importStickersZip(ctx);
    expect(res.imported).toBe(1);
    expect(res.skipped).toBe(0);
    // 建贴纸走 set("stickers", ..., {scope:"global"})——写 banner 文件经 writeBinary
    expect(sets.some((s) => s.key === "stickers" && s.scope === "global")).toBe(true);
    expect(written.length).toBe(1);
    expect(written[0].path).toContain("stickers/banners/");
    void created;
  });
});

describe("loadStickers 合并 builtin 层", () => {
  const builtinCtx = () => makeCtx({
    configFile: {
      ...makeCtx().configFile,
      get: async (path: string) => (path.includes("bundled")
        ? {
            stickers: [
              { id: "b1", title: "内置一", content: "内容一", banner: "~/.my-harness-desktop/stickers/bundled/banners/b1.gif" },
              { id: "b2", content: "内容二" },
            ],
          }
        : {}),
    },
  });

  it("builtin 条目追加在合并结果末尾,layer=builtin,order 按文件序,createdAt/updatedAt=0", async () => {
    const list = await loadStickers(builtinCtx());
    const builtin = list.filter((n) => n.layer === "builtin");
    expect(builtin).toHaveLength(2);
    expect(builtin[0]).toMatchObject({ id: "b1", order: 0, createdAt: 0, updatedAt: 0 });
    expect(builtin[1]).toMatchObject({ id: "b2", order: 1 });
    // project 层 1 条在前,builtin 恒垫后
    expect(list.map((n) => n.id)).toEqual(["a", "b1", "b2"]);
  });

  it("configFile.get 返回 {} 时 builtin 层为空不报错", async () => {
    const list = await loadStickers(makeCtx());
    expect(list.filter((n) => n.layer === "builtin")).toHaveLength(0);
    expect(list.map((n) => n.id)).toEqual(["a"]);
  });
});

describe("builtin 写守卫", () => {
  const spySet = (ctx: MockCtx): string[] => {
    const calls: string[] = [];
    (ctx as unknown as { config: { set: (k: string, v: unknown, o?: { scope?: string }) => Promise<void> } }).config.set = async (k) => {
      calls.push(k);
    };
    return calls;
  };
  const builtinCtx = () => makeCtx({
    configFile: { ...makeCtx().configFile, get: async () => ({ stickers: [{ id: "b1", content: "x" }] }) },
  });

  it("removeSticker 对 builtin id no-op(不触发 config.set)", async () => {
    const ctx = builtinCtx();
    const calls = spySet(ctx);
    await removeSticker(ctx, "b1");
    expect(calls).toHaveLength(0);
  });

  it("moveToLayer 对 builtin id 与 targetLayer=builtin 方向均 no-op", async () => {
    const ctx = builtinCtx();
    const calls = spySet(ctx);
    await moveToLayer(ctx, "b1", "global");
    await moveToLayer(ctx, "a", "builtin");
    expect(calls).toHaveLength(0);
  });
});

describe("reorderStickers 剔除 builtin", () => {
  it("orderedIds 含 builtin id 时被剔除,用户条目重编号不含 builtin 位", async () => {
    const writes: Record<string, Record<string, unknown>[]> = {};
    const ctx = makeCtx({
      configFile: { ...makeCtx().configFile, get: async () => ({ stickers: [{ id: "b1", content: "x" }] }) },
    });
    (ctx as unknown as { config: { set: (k: string, v: unknown, o?: { scope?: string }) => Promise<void> } }).config.set = async (k, v, o) => {
      writes[o?.scope ?? "project"] = v as Record<string, unknown>[];
    };
    // 合并列表:project 层 ["a"],builtin ["b1"];拖拽把 builtin id 混进 orderedIds 首位
    await reorderStickers(ctx, ["b1", "a"]);
    expect(writes.project[0]).toMatchObject({ id: "a", order: 0 });
    expect(writes.builtin).toBeUndefined();
  });
});
