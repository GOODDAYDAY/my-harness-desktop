// 圆心:fileIcons 槽的解析纯函数 —— 把贡献项清单摊平成"文件名/扩展名 → 图标"索引。
//
// 合并语义(与 contributions.ts FileIconContribution 注释钉的契约同源):
// 索引按清单顺序构建,后出现的贡献项在同一 key 上覆盖先出现者——
// registry 注册序 builtin → installed → user → project,故高优先级 source 自然胜出。
// 命中规则:文件名精确匹配(byName)优先,扩展名(byExt)其次,都未命中返回 null(消费方用默认图标)。
// 零外部依赖:不 import react/electron(圆心纯度纪律);vitest 直接单测。
import type { FileIconContribution } from "./contributions";

/** 文件图标索引:byName 精确文件名(小写),byExt 扩展名(小写,不带点)。 */
export interface FileIconIndex {
  byName: ReadonlyMap<string, FileIconContribution>;
  byExt: ReadonlyMap<string, FileIconContribution>;
}

export function buildFileIconIndex(contributions: readonly FileIconContribution[]): FileIconIndex {
  const byName = new Map<string, FileIconContribution>();
  const byExt = new Map<string, FileIconContribution>();
  for (const c of contributions) {
    for (const name of c.filenames ?? []) byName.set(name.toLowerCase(), c);
    for (const ext of c.extensions ?? []) byExt.set(ext.toLowerCase(), c);
  }
  return { byName, byExt };
}

/** 解析一个文件名( basename,不含目录)命中的贡献项;未命中返回 null。 */
export function resolveFileIcon(index: FileIconIndex, name: string): FileIconContribution | null {
  const lower = name.toLowerCase();
  const exact = index.byName.get(lower);
  if (exact) return exact;
  // 点开头文件(.gitignore)整体是文件名,不算有扩展名(dot === 0 不取)。
  const dot = lower.lastIndexOf(".");
  if (dot <= 0) return null;
  return index.byExt.get(lower.slice(dot + 1)) ?? null;
}
