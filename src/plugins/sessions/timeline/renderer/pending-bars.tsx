// composer 上方的两条「待发送」提示条：待发送图片、待发送文件。
//
// 从 `index.tsx` 抽出来的理由与本插件既有惯例一致（`MessageMeta.tsx` / `phase-icon.tsx`
// 都是独立文件 + 自带测试）：这两个是**纯展示组件**（props 进、DOM 出，无状态、无副作用），
// 埋在 1600+ 行的插件入口里既降低内聚、又没法单测——而它们承载的是"用户即将发送什么"的
// 可见确认，出错的代价是"以为附件带上了其实没带"。
//
// 附件语义（`index.tsx` 的 `ingestFiles`）：**绝对路径引用，不读 base64**——图片输入是
// 协议/模型能力，壳只传路径；不可参考的二进制在入口就被拒绝并 toast。
import { useTranslation } from "react-i18next";
import { FileText, X } from "lucide-react";
import type { ReactNode } from "react";

/** 待发送图条(composer 上方,表情包"加入输入框"的中间态):展示图 + 移除按钮。
 *  图以 dataUri 由贡献方(stickers)读文件提供,timeline 只挂载渲染不碰文件读取。 */
export function PendingImageBar({ image, onRemove }: { image: { src: string; title?: string; dataUri?: string }; onRemove: () => void }): React.ReactNode {
  const { t } = useTranslation();
  return (
    <div
      className="flex items-center gap-2 px-3 py-1.5 mb-2 rounded-[var(--radius-md)] bg-[var(--color-surface)] border border-[var(--color-border)]"
      style={{ width: "fit-content", maxWidth: "100%" }}
      // 待发送图片条的锚点：值是图片的 src（路径或 dataUri 的标识），与 PendingFileBar 同款纪律
      data-composer-pending-image={image.src}
    >
      {image.dataUri ? (
        <img src={image.dataUri} alt={image.title ?? t("timeline.pendingImageAlt")} className="h-16 w-auto max-w-[120px] rounded-[var(--radius-sm)] object-cover" />
      ) : (
        <span className="text-[var(--color-muted)] text-[length:var(--font-size-xs)] truncate max-w-[160px]">{image.src}</span>
      )}
      <span className="flex-1 min-w-0 text-[var(--color-muted)] text-[length:var(--font-size-xs)] truncate max-w-[220px]">
        {/* ⚠ 兜底名走 `shell.*` 而不是 `stickers.*`：本组件属 timeline 插件，
            依赖另一个**业务**插件的语言包是脆的（用户禁用 stickers 就丢文案、t() 回落裸 key）。
            `shell.*` 由 system/i18n 贡献、始终装载 —— 与 r52 把三个执行状态词搬进 shell.* 同理。 */}
            {image.title ?? t("shell.stickerFallback")}
      </span>
      <button
        type="button"
        onClick={onRemove}
        data-composer-pending-image-remove=""
        title={t("timeline.removeImage")}
        className="flex items-center justify-center size-6 rounded-full border-none bg-transparent text-[var(--color-muted)] hover:text-[var(--color-fg)] cursor-pointer shrink-0"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

/** 待发送文件条(composer 上方):绝对路径引用 + 移除按钮。文件是「参考文件」(AI 用工具读),
 *  展示的是绝对路径(契合「复制文件进来直接展示绝对路径」)。 */
export function PendingFileBar({ files, onRemove }: { files: Array<{ path: string; name: string }>; onRemove: (path: string) => void }): React.ReactNode {
  const { t } = useTranslation();
  return (
    // data-composer-pending-file*：待发送文件条的稳定锚点。chip 的身份就是**绝对路径**
    // （附件是路径引用、不读 base64），所以直接落成属性值——e2e 与审计据此按路径定位某个 chip，
    // 不必靠 title 译文或位置下标。
    <div className="flex flex-col gap-1 mb-2" style={{ width: "fit-content", maxWidth: "100%" }} data-composer-pending-files={String(files.length)}>
      {files.map((f) => (
        <div
          key={f.path}
          data-composer-pending-file={f.path}
          className="flex items-center gap-2 px-3 py-1.5 rounded-[var(--radius-md)] bg-[var(--color-surface)] border border-[var(--color-border)]"
          style={{ maxWidth: "100%" }}
        >
          <FileText className="size-3.5 shrink-0 text-[var(--color-muted)]" />
          <span
            className="min-w-0 text-[var(--color-muted)] text-[length:var(--font-size-xs)] truncate font-[var(--font-family-mono)]"
            title={f.path}
          >
            {f.path}
          </span>
          <button
            type="button"
            data-composer-pending-file-remove={f.path}
            onClick={() => onRemove(f.path)}
            title={t("timeline.removeFile")}
            className="flex items-center justify-center size-6 rounded-full border-none bg-transparent text-[var(--color-muted)] hover:text-[var(--color-fg)] cursor-pointer shrink-0"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
