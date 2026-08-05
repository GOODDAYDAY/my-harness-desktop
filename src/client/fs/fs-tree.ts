// fs-tree.ts —— 目录树递归 walk(fs:readDirTree IPC 的实现函数)。
//
// 分层归属:纯执行函数,不决策 ignore/maxDepth 默认值(调用方经 ReadDirTreeOptions 传入),
// 也不关心 FileTreeNode 长什么样(domain 契约)。测试节点脚本可直接 require 验证。
import { promises as fsp } from "node:fs";

export interface WalkNode {
  name: string;
  isDir: boolean;
  children?: WalkNode[];
}

/**
 * 递归 walk 一个目录,返回目录树。
 * - ignore 里的目录名按名跳过,不回读其子树(省 IO、屏蔽 node_modules 等大目录)。
 * - maxDepth 限制递归深度;depth 从 0 起(根=0)。
 * - children 语义:缺席(undefined)= 未下钻(限深边界或读失败),空数组 = 已 walk 的空目录——
 *   消费方(文件树)据此区分"待展开懒加载"和"真空目录"。
 * - 排序不在此做(目录在前字母序是渲染语义,由 widget 收敛)。
 */
export async function walkDirTree(
  dir: string,
  opts: { maxDepth?: number; ignore?: string[] } = {},
  depth: number = 0,
): Promise<WalkNode> {
  const maxDepth = opts.maxDepth ?? 3;
  const ignoreSet = new Set(opts.ignore ?? []);
  const name = dir.split("/").filter(Boolean).pop() ?? dir;

  if (depth >= maxDepth) {
    return { name, isDir: true };
  }

  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return { name, isDir: true };
  }

  const node: WalkNode = { name, isDir: true, children: [] };

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      node.children!.push({ name: entry.name, isDir: false });
      continue;
    }
    if (ignoreSet.has(entry.name)) {
      continue;
    }
    try {
      const child = await walkDirTree(`${dir}/${entry.name}`, { maxDepth, ignore: opts.ignore }, depth + 1);
      child.name = entry.name;
      node.children!.push(child);
    } catch {
      // 单个子目录失败不中断
    }
  }

  return node;
}
