// 圆心:输入框附件文件分类纯函数(零依赖,main 与 renderer 共用)。
//
// 语义(设计 docs/design/composer-file-attach.md):「标准 AI 可参考的文件」分两类——
//   文本/代码 → "file"(绝对路径引用,AI 用工具读);图片 → "image"(同样绝对路径引用)。
//   图片输入是协议/模型能力,壳不读 base64——分类只标记类型,消费方一律按路径引用。
//   二进制(zip/exe/pdf 等)不可参考 → null(显式降级,调用方拒绝并提示)。
// 分类只按名字(扩展名 + 无扩展名的已知配置/文档名),不做内容嗅探。

const IMAGE_EXTS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif", "tiff", "tif",
]);

const TEXT_EXTS = new Set([
  // 文档/标记
  "md", "markdown", "txt", "text", "log", "rst", "adoc", "org", "tex",
  // 结构化/配置
  "json", "jsonc", "json5", "yaml", "yml", "toml", "ini", "cfg", "conf", "xml",
  "csv", "tsv", "properties", "plist", "env", "lock",
  // 脚本
  "js", "jsx", "ts", "tsx", "mjs", "cjs", "mts", "cts",
  "py", "pyw", "rb", "go", "rs", "java", "kt", "kts", "scala", "clj", "cljs", "cljc", "edn",
  "c", "h", "cc", "cpp", "cxx", "hpp", "hh", "cs", "fs", "fsx", "vb", "swift", "m", "mm",
  "php", "pl", "pm", "lua", "r", "jl", "dart", "ex", "exs", "erl", "hrl", "hs", "elm", "ml", "mli",
  "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd",
  "sql", "graphql", "gql", "prisma",
  // Web
  "html", "htm", "css", "scss", "sass", "less", "styl", "vue", "svelte", "astro", "svg",
  // 点文件常见「扩展名」(.gitignore → ext "gitignore")
  "gitignore", "gitattributes", "gitmodules", "gitkeep", "editorconfig", "npmrc",
  "eslintrc", "eslintignore", "prettierrc", "prettierignore", "babelrc", "dockerignore",
  "nvmrc", "yarnrc", "bashrc", "zshrc", "profile", "curlrc", "wgetrc",
  // 模块/依赖描述
  "mod", "sum",
]);

/** 无扩展名的已知配置/文档名(大小写不敏感)。 */
const NO_EXT_NAMES = new Set([
  "makefile", "dockerfile", "containerfile", "readme", "license", "licence", "notice",
  "changelog", "authors", "contributing", "codeowners", "procfile", "justfile",
  "gemfile", "rakefile", "vagrantfile",
]);

export type ReferenceFileKind = "file" | "image";

/** 取 basename(去路径段,兼容 / 与 \)。 */
function basename(name: string): string {
  const idx = Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\"));
  return idx === -1 ? name : name.slice(idx + 1);
}

/** 按文件名分类:「标准 AI 可参考」返回 "file"/"image",不可参考返回 null。 */
export function classifyReferenceFile(name: string): ReferenceFileKind | null {
  const base = basename(name.trim());
  if (!base) return null;
  const lower = base.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot === -1) {
    // 无扩展名(Makefile/README/…):按已知名匹配。
    return NO_EXT_NAMES.has(lower) ? "file" : null;
  }
  // dot >= 0:扩展名 = 最后一个点之后。点文件(.gitignore)dot=0 → ext="gitignore"。
  const ext = lower.slice(dot + 1);
  if (IMAGE_EXTS.has(ext)) return "image";
  if (TEXT_EXTS.has(ext)) return "file";
  // 点文件整体名(.dockerignore 等)兜底一次已知名。
  if (dot === 0 && NO_EXT_NAMES.has(lower)) return "file";
  return null;
}

/** 是否可参考(文件或图片)。 */
export function isReferenceableFile(name: string): boolean {
  return classifyReferenceFile(name) !== null;
}

/** 一次拖拽/粘贴的**分流结果**（r144）：能参考的（带路径）+ 被拒收的数量。 */
export interface ReferenceFileIntake {
  /** 收下的条目。`path` 是宿主给的绝对路径，拿不到时回落成文件名（见 partitionReferenceFiles）。 */
  accepted: Array<{ path: string; name: string }>;
  /** 拒收数（>0 时调用方要告知用户，§7.6：不许静默丢弃）。 */
  rejectedCount: number;
}

/**
 * 把一批拖拽/粘贴进来的文件分流成「可参考」与「拒收」（r144，纯函数）。
 *
 * ## 为什么抽出来
 *
 * 这段逻辑原先内联在 `timeline/renderer/index.tsx` 的 `ingestFiles` 回调里（约 14 行），
 * 于是**没法单测**：要测它就得渲染整个 timeline（1400 行组件 + store + 事件总线）。
 * 按 §4.5 的判据——「这个东西的单元测试需不需要 mock 外部环境？需要 mock 的说明它碰了外层，
 * 该把依赖的部分推到外层去」——这里唯一的外层依赖是**取绝对路径**那一步
 * （`window.mhdFile.getPathForFile(f)`，Electron 的 webUtils 能力），
 * 所以把它作为**参数注入**（`pathOf`），剩下的分类/分流/回落全是纯逻辑，落回圆心。
 *
 * ## 语义（与原实现逐条对齐，不是重写）
 *
 * · 分类沿用 `classifyReferenceFile`（标准 AI 可参考 ⇒ "file"/"image"，否则 null ⇒ 拒收）；
 * · **路径回落**：`pathOf` 返回空串/undefined 时用文件名（浏览器宿主没有 `mhdFile`，
 *   此时只能按名字引用；这比丢掉整个文件好——§1.5 的「显式降级」而非「静默缺面」）；
 * · `accepted` 保持**输入顺序**（用户拖进来的顺序就是他期望的顺序）；
 * · 空输入 ⇒ `{ accepted: [], rejectedCount: 0 }`（不报错、不弹提示）。
 */
export function partitionReferenceFiles(
  files: Array<{ name: string }>,
  pathOf: (file: { name: string }) => string | undefined,
): ReferenceFileIntake {
  const accepted: Array<{ path: string; name: string }> = [];
  let rejectedCount = 0;
  for (const f of files) {
    if (classifyReferenceFile(f.name) === null) { rejectedCount++; continue; }
    accepted.push({ path: pathOf(f) || f.name, name: f.name });
  }
  return { accepted, rejectedCount };
}
