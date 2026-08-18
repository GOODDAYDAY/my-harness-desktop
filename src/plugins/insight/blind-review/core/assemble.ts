// prompt 组装纯函数 —— 构造与执行分开:这里只拼文本,发送在 client/squad-runner。
//
// 组装规则(对齐 docs/plugins/blind-review.md §3.4–§3.6):
// - {{content}} 被审内容(截断保护),{{tree}} 项目文件树(仅白盒队),{{reports}} 各队报告(裁判)
// - 占位符缺席 = 用户的选择,不注入、不报错(与旧版 {{content}} 语义一致)
// - 截断标注写进 prompt 正文,让审查方知道输入不完整——不静默
// - 一切自然语言标注经 AssembleLabels 由调用方按界面语言注入,core 不硬编码文案

import type { FileTreeNode } from "@my-harness-desktop/contract";
import type { JudgeConfig, TeamConfig } from "./config";

/** 内容长度上限:超出截断并标注(fs.readFile 的 1MB 上限远大于模型合理输入)。 */
export const CONTENT_MAX_CHARS = 100_000;
/** 文件树序列化行数上限:树是"代码与周边关系"的线索,不是全文 dump。 */
export const TREE_MAX_LINES = 200;
/** readDirTree 的忽略目录(调用方内容,内核按名跳过不回读)。 */
export const TREE_IGNORE_DIRS = ["node_modules", ".git", "dist", "build", "out", "coverage", ".next", ".cache"];

/** 组装期文案标注(reportHeading/failedHeading 含 {{name}} 占位,拼装时替换为队名)。 */
export interface AssembleLabels {
  reportHeading: string;
  failedHeading: string;
  contentTruncated: string;
  treeTruncated: string;
}

export interface TeamReport {
  teamId: string;
  teamName: string;
  text: string;
  ok: boolean;
}

/** 截断保护:超上限截断 + 正文标注。 */
export function truncateContent(text: string, labels: AssembleLabels): string {
  if (text.length <= CONTENT_MAX_CHARS) return text;
  return `${text.slice(0, CONTENT_MAX_CHARS)}\n\n${labels.contentTruncated}`;
}

/** 文件树 → 缩进文本,超行数截断 + 标注。 */
export function serializeTree(root: FileTreeNode, labels: AssembleLabels): string {
  const lines: string[] = [];
  const walk = (node: FileTreeNode, depth: number): void => {
    if (lines.length >= TREE_MAX_LINES) return;
    lines.push(`${"  ".repeat(depth)}${node.name}${node.isDir ? "/" : ""}`);
    for (const child of node.children ?? []) walk(child, depth + 1);
  };
  walk(root, 0);
  if (lines.length >= TREE_MAX_LINES) lines.push(labels.treeTruncated);
  return lines.join("\n");
}

/** 蓝队 prompt:{{content}} 替换为截断后内容;白盒队 {{tree}} 替换为序列化树(占位缺席不注入)。 */
export function assembleTeamPrompt(team: TeamConfig, content: string, tree: string | null, labels: AssembleLabels): string {
  let out = team.prompt.replace("{{content}}", truncateContent(content, labels));
  if (tree !== null) out = out.replace("{{tree}}", tree);
  return out;
}

/** 各队报告拼装:失败队如实标注——裁判需要知道覆盖缺口。 */
export function assembleReports(reports: TeamReport[], labels: AssembleLabels): string {
  return reports
    .map((r) => {
      const heading = (r.ok ? labels.reportHeading : labels.failedHeading).replace("{{name}}", r.teamName);
      return `${heading}\n${r.text}`;
    })
    .join("\n\n");
}

/** 裁判 prompt:{{content}} + {{reports}} 双占位。 */
export function assembleJudgePrompt(judge: JudgeConfig, content: string, reports: TeamReport[], labels: AssembleLabels): string {
  return judge.prompt
    .replace("{{content}}", truncateContent(content, labels))
    .replace("{{reports}}", assembleReports(reports, labels));
}
