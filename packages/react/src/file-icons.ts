// file-icons.ts —— fileIcons 槽的 renderer 侧机制:查询 + 索引构建。
//
// 与 file-actions 同范式(声明走 manifest,消费方查槽):
// ① 声明:贡献者在 plugin.json 写 contributes.fileIcons(扩展名/文件名 → 图标规则);
// ② 消费:文件树经 useFileIcons() 查槽(pluginsNonce 失效重拉),
//    buildFileIconIndex/resolveFileIcon(domain 纯函数,经 contract re-export)解析每行图标。
// 覆盖语义在 domain/file-icons.ts:同 key 后注册者(高优先级 source)胜出。
import { useEffect, useMemo, useState } from "react";
import { buildFileIconIndex, type FileIconContribution, type FileIconIndex } from "@my-harness-desktop/contract";
import { useUiStore } from "../../../src/web/stores/ui-store";

/** fileIcons 槽查询项:贡献声明 + 来源 pluginId(registry.fileIconItems 的运行时形态)。 */
export type FileIconItem = FileIconContribution & { pluginId: string };

let cache: { nonce: number; data: FileIconItem[] } | null = null;

/** 查 fileIcons 槽全部贡献(同 useFileActions:nonce 单发缓存,失效重拉)。 */
export function useFileIcons(): FileIconItem[] {
  const pluginsNonce = useUiStore((s) => s.pluginsNonce);
  const [data, setData] = useState<FileIconItem[]>(
    () => (cache && cache.nonce === pluginsNonce ? cache.data : []),
  );
  useEffect(() => {
    let alive = true;
    void window.kernel.slots.fileIcons().then((d) => {
      cache = { nonce: pluginsNonce, data: d };
      if (alive) setData(d);
    });
    return () => { alive = false; };
  }, [pluginsNonce]);
  return data;
}

/** 查槽 + 建索引一步完成(文件树等按行解析图标的消费方直接用这个)。 */
export function useFileIconIndex(): FileIconIndex {
  const items = useFileIcons();
  return useMemo(() => buildFileIconIndex(items), [items]);
}
