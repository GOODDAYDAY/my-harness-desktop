import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { walkDirTree } from "./fs-tree";

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "fs-tree-test-"));
  mkdirSync(join(root, "a/b/c"), { recursive: true });
  writeFileSync(join(root, "a/b/c/deep.txt"), "x");
  mkdirSync(join(root, "empty"));
  mkdirSync(join(root, "skip"));
  writeFileSync(join(root, "skip/x.txt"), "x");
  writeFileSync(join(root, "top.txt"), "x");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("walkDirTree children 语义", () => {
  it("限深边界的目录 children 缺席(未下钻),与空目录区分", async () => {
    const tree = await walkDirTree(root, { maxDepth: 2 });
    const a = tree.children!.find((n) => n.name === "a")!;
    const b = a.children!.find((n) => n.name === "b")!;
    expect(b.isDir).toBe(true);
    expect(b.children).toBeUndefined();
  });

  it("已 walk 的空目录 children 是空数组", async () => {
    const tree = await walkDirTree(root, { maxDepth: 2 });
    const empty = tree.children!.find((n) => n.name === "empty")!;
    expect(empty.children).toEqual([]);
  });

  it("限深边界之下的文件不出现", async () => {
    const tree = await walkDirTree(root, { maxDepth: 2 });
    const a = tree.children!.find((n) => n.name === "a")!;
    const names = JSON.stringify(a);
    expect(names).not.toContain("deep.txt");
  });

  it("ignore 目录按名跳过", async () => {
    const tree = await walkDirTree(root, { maxDepth: 4, ignore: ["skip"] });
    const names = tree.children!.map((n) => n.name);
    expect(names).not.toContain("skip");
    expect(names).toContain("top.txt");
  });

  it("默认限深 3(根=0)", async () => {
    const tree = await walkDirTree(root);
    const a = tree.children!.find((n) => n.name === "a")!;
    const b = a.children!.find((n) => n.name === "b")!;
    const c = b.children!.find((n) => n.name === "c")!;
    expect(c.children).toBeUndefined();
  });

  it("以边界目录为根再 walk 可继续下钻(懒加载语义成立)", async () => {
    const subtree = await walkDirTree(join(root, "a/b"), { maxDepth: 1 });
    const c = subtree.children!.find((n) => n.name === "c")!;
    expect(c.children).toBeUndefined();
    const deeper = await walkDirTree(join(root, "a/b/c"), { maxDepth: 1 });
    expect(deeper.children!.map((n) => n.name)).toContain("deep.txt");
  });
});
