// 旧会话导入（壳侧机制）守卫 —— 与内核侧的读取面分工是这条契约的全部要点：
//   内核（KernelPlugin.readLegacySessions）懂自己的老格式 → 交出中立会话；
//   壳（本文件）懂中立层 → 幂等落库。
// 分工不是洁癖：混在一起时 application 必须 import 某个内核实现，那曾是 dependency-audit
// 里唯一一条被明文豁免的红线例外（现已清空）。这组守卫同时钉住"例外不会再回来"。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importLegacySessions } from "./legacy-import";
import { NeutralSessionStore } from "./neutral-session-store";
import { emptyNeutralSession, type KernelPlugin, type NeutralSession } from "@my-harness-desktop/shared";

let dir: string;
let store: NeutralSessionStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "legacy-import-"));
  store = new NeutralSessionStore(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 最小内核插件替身：只带 id +（可选）旧会话读取面。 */
function plugin(id: string, sessions?: NeutralSession[] | (() => NeutralSession[])): KernelPlugin {
  return {
    id,
    readLegacySessions: typeof sessions === "function" ? sessions : sessions ? () => sessions : undefined,
  } as unknown as KernelPlugin;
}

const legacy = (ns: string, cwd = "/proj"): NeutralSession => emptyNeutralSession(ns, { kernel: "any", cwd, createdAt: "2020-01-01T00:00:00.000Z" });

describe("importLegacySessions:逐内核问、壳负责幂等落库", () => {
  it("内核交出的旧会话被写进中立层（此后列表/打开都能看见）", () => {
    const r = importLegacySessions([plugin("a", [legacy("ns-1"), legacy("ns-2")])], store);
    expect(r).toMatchObject({ imported: 2, skipped: 0 });
    expect(store.get("ns-1")).not.toBeNull();
    expect(store.get("ns-2")).not.toBeNull();
  });

  it("幂等：中立层已有的跳过（重复启动不会覆盖用户当前的会话内容）", () => {
    importLegacySessions([plugin("a", [legacy("ns-1")])], store);
    // 用户已在中立层里改过这个会话（比如改了名）
    store.putHeader("ns-1", { ...store.get("ns-1")!.header, name: "用户改过的名字" });
    const r = importLegacySessions([plugin("a", [legacy("ns-1")])], store);
    expect(r).toMatchObject({ imported: 0, skipped: 1 });
    expect(store.get("ns-1")!.header.name, "重复导入把用户改过的会话覆盖了").toBe("用户改过的名字");
  });

  it("没有该面的内核被跳过（不为每个内核造一个空实现）", () => {
    const r = importLegacySessions([plugin("a"), plugin("b", [legacy("ns-b")])], store);
    expect(r.imported).toBe(1);
    expect(store.get("ns-b")).not.toBeNull();
  });

  it("某个内核读取抛错：点名记下、不静默、也不影响其它内核", () => {
    const boom = () => { throw new Error("内核读盘炸了"); };
    const r = importLegacySessions([plugin("broken", boom), plugin("ok", [legacy("ns-ok")])], store);
    expect(r.failedKernels).toEqual(["broken"]);
    expect(r.imported, "一个内核坏了不该拖垮其它内核的导入").toBe(1);
    expect(store.get("ns-ok")).not.toBeNull();
  });

  it("空清单/无插件：零导入且不抛（冷启动无历史是正常态）", () => {
    expect(importLegacySessions([], store)).toMatchObject({ imported: 0, skipped: 0, failedKernels: [] });
    expect(importLegacySessions([plugin("a", [])], store)).toMatchObject({ imported: 0 });
  });
});
