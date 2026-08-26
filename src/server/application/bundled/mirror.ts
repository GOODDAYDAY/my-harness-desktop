// 受管目录镜像 —— application/bundled/mirror。
//
// 仓库内随壳分发的资产(内置 skills、内置表情包)启动时镜像到数据根受管目录。
// 语义是"强制覆盖":target 中 source 没有的条目删除,其余整目录覆盖拷贝——
// 受管目录归壳所有,用户要改请 fork 到自己的目录(自己的 skills 目录、自己的贴纸),
// 不要直接改受管目录里的内容,否则下次启动被覆盖回源。skills 与内置表情包共用此份。
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/** 镜像受管目录(source → target,强制覆盖):target 中 source 没有的条目删除,其余整目录
 *  覆盖拷贝。. 开头条目(隐藏文件)不参与同步,与 scanner 的跳过规则一致。 */
export function mirrorManagedDir(sourceDir: string, targetDir: string): void {
  if (!existsSync(sourceDir)) return;
  mkdirSync(targetDir, { recursive: true });
  const sourceEntries = new Set(readdirSync(sourceDir).filter((e) => !e.startsWith(".")));
  for (const entry of readdirSync(targetDir)) {
    if (entry.startsWith(".")) continue;
    if (!sourceEntries.has(entry)) rmSync(join(targetDir, entry), { recursive: true, force: true });
  }
  for (const entry of sourceEntries) {
    cpSync(join(sourceDir, entry), join(targetDir, entry), { recursive: true, force: true });
  }
}
