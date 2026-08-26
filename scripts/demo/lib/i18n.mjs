// i18n key 解析 —— 消费应用自己合并好的资源(window.kernel.i18n.resources()),不重放合并逻辑。
//
// 资源形态(core/application/i18n/merge.ts):{ locale: { ns: 嵌套 key 树 } }。
// 扁平 key 拆分规则与 merge 一致:第一个 dot 前是 namespace(无 dot 走 common),
// 剩余部分按 '.' 分层嵌套。查找 miss 时回落 en(对齐 i18next fallbackLng: "en")。
export async function createResolver(page, locale) {
  const { resources } = await page.evaluate(() => window.kernel.i18n.resources());
  // miss 回落 en,再回落 key 本身——对齐 i18next 缺 key 返回完整 key 的行为,
  // 保证解析结果与 UI 实际渲染文本一致(无 defaultValue 的调用点 UI 也显示 key)。
  return (key) => lookup(resources, locale, key) ?? lookup(resources, "en", key) ?? key;
}

function lookup(resources, locale, key) {
  const dot = key.indexOf(".");
  const ns = dot === -1 ? "common" : key.slice(0, dot);
  const rest = dot === -1 ? key : key.slice(dot + 1);
  let node = resources?.[locale]?.[ns];
  for (const part of rest.split(".")) {
    if (node === null || typeof node !== "object") return null;
    node = node[part];
  }
  return typeof node === "string" ? node : null;
}
