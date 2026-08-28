// DshSessionCatalog.rawFilePath 裸单测:原始文件位置是内核专属知识(§7.6)——
// dsh 投影地址是裸 lineageId(坐标系,不是文件路径),真实落盘形状是
// <sessionRoot>/<cwd 桶>/<lineageId>/session.jsonl.zstd。fixture:tmp 目录真文件,不 mock。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cwdToBucketName } from "@my-harness-desktop/shared";
import { DshSessionCatalog } from "./dsh-catalog";

const CWD = "/Users/someone/proj";
let sessionRoot: string;

/** transport 不会被 rawFilePath 用到;给个必炸工厂,误触即暴露。 */
const createTransport = async (): Promise<never> => {
  throw new Error("rawFilePath 不应 spawn dsh transport");
};

beforeEach(() => {
  sessionRoot = mkdtempSync(join(tmpdir(), "dsh-catalog-raw-"));
});

afterEach(() => {
  rmSync(sessionRoot, { recursive: true, force: true });
});

describe("rawFilePath", () => {
  it("会话文件存在 → <root>/<cwd 桶>/<lineageId>/session.jsonl.zstd", () => {
    const lineageId = "810e80f9-ced1-4f11-a364-3873358ccad0";
    const dir = join(sessionRoot, cwdToBucketName(CWD), lineageId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "session.jsonl.zstd"), "");
    const catalog = new DshSessionCatalog({ createTransport, sessionRoot });
    expect(catalog.rawFilePath(CWD, lineageId)).toBe(join(dir, "session.jsonl.zstd"));
  });

  it("会话文件不存在(临时会话/未落盘)→ null,不返回幽灵地址", () => {
    const catalog = new DshSessionCatalog({ createTransport, sessionRoot });
    expect(catalog.rawFilePath(CWD, "missing-lineage")).toBeNull();
  });

  it("sessionRoot 未注入(组装缺面)→ null,显式降级不硬猜", () => {
    const catalog = new DshSessionCatalog({ createTransport });
    expect(catalog.rawFilePath(CWD, "any-lineage")).toBeNull();
  });
});
