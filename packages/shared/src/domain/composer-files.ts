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
