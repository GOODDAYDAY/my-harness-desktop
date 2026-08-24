// client/dsh/dsh-extension-manifest.ts —— 随附 dsh 扩展的 extension.json 清单契约。
//
// 本地 dsh 扩展目录(dsh-extension/)是「自描述结构」:index.mjs(cordis 插件入口)+
// extension.json(展示元数据单一真相源)。本文件是该清单的形状——同步端(dsh-extension-installer)
// 校验它、展示端(dsh-extension-manager)读它。加一个新的本地扩展 = 建这个目录 + 写这两个文件,
// 缺 manifest 时展示回落 cordis id(不是裸路径),同步打告警提醒补齐。
// 依赖方向只向内:纯类型,零依赖。

/** 随附 dsh 扩展的 extension.json 清单——{ displayName, description }。 */
export interface DshExtensionManifest {
  /** 展示名(如 "提问")。缺失时展示回落 cordis id 剥 my-harness-desktop- 前缀。 */
  displayName: string;
  /** 一句话描述(能力/用途)。 */
  description?: string;
}
