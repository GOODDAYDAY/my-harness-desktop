// 目标定位 —— 剧本 target → 视口坐标。跨语言的核心:不找文本字面量,找语义锚点。
//
// target 形状:
//   { i18nKey: "shell.settings" }                    i18n key → 当前 locale 文本(运行时解析)
//   { text: "Mocha Dark" }                           字面文本(主题卡专名等不翻译的)
//   { themeCard: "mocha-dark" }                      主题卡:themes.list() 查名,名字是 key 就走解析
//   { css: "[role=tab]" }                            CSS 选择器(逃生舱)
// 公共选项:within(css 圈定搜索域)、nth(0 基,多命中时取第几个)。
//
// 文本匹配两轮:先"直接文本节点"(元素自身含目标文本),miss 再退"叶子元素 textContent"。
// 命中后 scrollIntoView 居中再取 rect(设置页可滚动),返回中心点坐标。
export async function locate(page, target, resolve) {
  const within = target.within ?? null;
  const nth = target.nth ?? 0;
  let text = null;
  let css = null;

  if (target.i18nKey) {
    text = resolve(target.i18nKey);
    if (!text) throw new Error(`i18n key 未解析出来: ${target.i18nKey}`);
  } else if (target.text) {
    text = target.text;
  } else if (target.themeCard) {
    text = await themeCardLabel(page, target.themeCard, resolve);
  } else if (target.css) {
    css = target.css;
  } else {
    throw new Error(`未知 target: ${JSON.stringify(target)}`);
  }

  const found = await page.evaluate(({ text, css, within, nth }) => {
    const isVisible = (el) => {
      if (typeof el.checkVisibility === "function") {
        return el.checkVisibility({ checkVisibilityCSS: true, checkOpacity: false });
      }
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    // within 可能命中多处(chat/settings 双树各有一个 [data-sidebar-style]),取第一个可见的
    const scope = within
      ? [...document.querySelectorAll(within)].find(isVisible)
      : document.body;
    if (!scope) return { error: `搜索域不存在或不可见: ${within}` };
    const all = scope.querySelectorAll("*");

    const candidates = [];
    if (css) {
      for (const el of scope.querySelectorAll(css)) candidates.push(el);
    } else {
      for (const el of all) {
        let direct = "";
        for (const n of el.childNodes) if (n.nodeType === 3) direct += n.textContent;
        if (direct.trim() === text) candidates.push(el);
      }
      if (candidates.length === 0) {
        for (const el of all) {
          if (el.children.length === 0 && (el.textContent ?? "").trim() === text) candidates.push(el);
        }
      }
    }

    // 可见性过滤:chat/settings 双树同 DOM(visibility 切换)、设置 pane 挂载后 display:none 保留,
    // 仅靠 rect 尺寸判不掉——checkVisibility 感知祖先链的 visibility/display。
    const visible = candidates.filter(isVisible);
    if (visible.length === 0) {
      return {
        error: `无命中: ${text ?? css}(候选 ${candidates.length} 个均不可见;域内元素 ${all.length})`,
      };
    }
    if (nth >= visible.length) {
      return { error: `第 ${nth} 个命中越界(共 ${visible.length} 个): ${text ?? css}` };
    }
    const el = visible[nth];
    el.scrollIntoView({ block: "center", behavior: "instant" });
    const r = el.getBoundingClientRect();
    return {
      x: r.left + r.width / 2,
      y: r.top + r.height / 2,
      label: (el.textContent ?? "").trim().slice(0, 40),
      matches: visible.length,
    };
  }, { text, css, within, nth });

  if (found.error) throw new Error(`定位失败: ${found.error}`);
  return found;
}

/** 主题卡显示名:themes.list() 按 id 查;名字含 '.' 的是 i18n key(theme-tab 同款判定)。 */
async function themeCardLabel(page, themeId, resolve) {
  const themes = await page.evaluate(() => window.pi.themes.list());
  const hit = themes.find((t) => t.id === themeId);
  if (!hit) throw new Error(`主题不存在: ${themeId}`);
  if (hit.name.includes(".")) {
    const label = resolve(hit.name);
    if (!label) throw new Error(`主题名 key 未解析出来: ${hit.name}`);
    return label;
  }
  return hit.name;
}
