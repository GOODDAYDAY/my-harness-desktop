/** 圆心:跨平台路径纯函数。
 *
 * 中性纪律:零依赖、不感知运行平台——pathBasename 同一函数同时按 / 与 \ 切分,
 * 天然覆盖 mac/linux 的 POSIX 路径与 windows 的盘符/UNC 路径。
 * 不要用 node:path 或 process.platform:那是外层运行时细节,圆心不碰
 * (替换运行时、换平台,圆心一行不改)。
 *
 * 收敛来源:projects/file-tree/file-preview 曾各写一份 split("/") 取末段,
 * windows 下反斜杠路径取不到段、整串回退成显示全路径的 bug(见 git 历史);统一收敛到这里。 */

/** 取路径末段(目录名/文件名)。同时按 / 与 \ 切分,尾部连续分隔符视为空段忽略;
 *  退化输入(空串、纯分隔符)回退原串。 */
export function pathBasename(p: string): string {
  const parts = p.split(/[/\\]+/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1]! : p;
}
