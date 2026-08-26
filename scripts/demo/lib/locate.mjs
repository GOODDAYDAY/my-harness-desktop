// 目标定位 —— 剧本 target → 视口坐标。跨语言的核心:不找文本字面量,找语义锚点。
//
// target 形状:
//   { i18nKey: "shell.settings" }                    i18n key → 当前 locale 文本(运行时解析)
//   { text: "Mocha Dark" }                           字面文本(主题卡专名等不翻译的)
//   { themeCard: "mocha-dark" }                      主题卡:themes.list() 查名,名字是 key 就走解析
//   { titleKey: "debug.inspectTitle" }               title 属性=i18n 文本(图标按钮)
//   { titleText: "笔记" }                             title 属性=字面(manifest label 等不翻译的)
//   { placeholderKey: "shell.placeholder" }          placeholder 属性=i18n 文本(输入框)
//   { palettePin: "#89b4fa" }                        图钉调色板:svg ellipse fill 匹配
//   { groupToggle: "read-only" }                     tool-manager 组行:名字文本左邻的开关
//   { css: "[role=tab]" }                            CSS 选择器(逃生舱)
// 公共选项:within(css 圈定搜索域)、nth(0 基,多命中时取第几个)。
//
// 文本匹配两轮:先"直接文本节点"(元素自身含目标文本),miss 再退"叶子元素 textContent"。
// 命中后 scrollIntoView 居中再取 rect(设置页可滚动),返回中心点坐标。
const attrEscape = (s) => s.replace(/"/g, '\\"');

export async function locate(page, target, resolve) {
  const within = target.within ?? null;
  const nth = target.nth ?? 0;
  let text = null;
  let css = null;

  if (target.i18nKey) {
    text = resolve(target.i18nKey);
  } else if (target.text) {
    text = target.text;
  } else if (target.themeCard) {
    text = await themeCardLabel(page, target.themeCard, resolve);
  } else if (target.titleKey) {
    css = `[title="${attrEscape(resolve(target.titleKey))}"]`;
  } else if (target.titleText) {
    css = `[title="${attrEscape(target.titleText)}"]`;
  } else if (target.placeholderKey) {
    css = `[placeholder="${attrEscape(resolve(target.placeholderKey))}"]`;
  } else if (target.palettePin) {
    css = `svg ellipse[fill="${target.palettePin}"]`;
  } else if (target.css) {
    css = target.css;
  } else if (target.groupToggle) {
    const found = await locateGroupToggle(page, target.groupToggle, within, nth);
    if (found.error) throw new Error(`定位失败: ${found.error}`);
    return found;
  } else {
    throw new Error(`未知 target: ${JSON.stringify(target)}`);
  }

  let found;
  for (let attempt = 0; ; attempt++) {
    found = await page.evaluate(({ text, css, within, nth, extra }) => {
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
      const hit = (d) => (extra?.contains ? d.includes(text) : d === text);
      for (const el of all) {
        let direct = "";
        for (const n of el.childNodes) if (n.nodeType === 3) direct += n.textContent;
        if (hit(direct.trim())) candidates.push(el);
      }
      if (candidates.length === 0) {
        for (const el of all) {
          if (el.children.length === 0 && hit((el.textContent ?? "").trim())) candidates.push(el);
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
    const el = extra?.widest
      ? visible.reduce((a, b) => (b.getBoundingClientRect().width > a.getBoundingClientRect().width ? b : a))
      : visible[nth];
    el.scrollIntoView({ block: "center", behavior: "instant" });
    const r = el.getBoundingClientRect();
    return {
      x: r.left + r.width / 2,
      y: r.top + r.height / 2,
      width: r.width,
      height: r.height,
      label: (el.textContent ?? "").trim().slice(0, 40),
      matches: visible.length,
    };
    }, { text, css, within, nth, extra: { widest: target.widest, contains: target.contains } });
    if (!found.error || attempt >= 10) break;
    await new Promise((r) => setTimeout(r, 400));
  }

  if (found.error) throw new Error(`定位失败: ${found.error}`);
  return found;
}

/** tool-manager 组开关:组名 span 无可用属性,结构走位——
 *  name span → 名字行 div → flex-1 容器 → previousElementSibling 即开关 div(无文本,点它 toggle)。 */
async function locateGroupToggle(page, name, within, nth) {
  return page.evaluate(({ name, within, nth }) => {
    const isVisible = (el) => {
      if (typeof el.checkVisibility === "function") {
        return el.checkVisibility({ checkVisibilityCSS: true, checkOpacity: false });
      }
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const scope = within
      ? [...document.querySelectorAll(within)].find(isVisible)
      : document.body;
    if (!scope) return { error: `搜索域不存在或不可见: ${within}` };
    const names = [...scope.querySelectorAll("span")].filter((el) => {
      let d = "";
      for (const n of el.childNodes) if (n.nodeType === 3) d += n.textContent;
      return d.trim() === name && isVisible(el);
    });
    if (nth >= names.length) return { error: `组名 ${name} 第 ${nth} 个越界(共 ${names.length})` };
    const toggle = names[nth]?.parentElement?.parentElement?.previousElementSibling;
    if (!toggle) return { error: `组名 ${name} 旁找不到开关` };
    toggle.scrollIntoView({ block: "center", behavior: "instant" });
    const r = toggle.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, label: `toggle:${name}`, matches: names.length };
  }, { name, within, nth });
}

/** 主题卡显示名:themes.list() 按 id 查;名字含 '.' 的是 i18n key(theme-tab 同款判定)。 */
async function themeCardLabel(page, themeId, resolve) {
  const themes = await page.evaluate(() => window.kernel.themes.list());
  const hit = themes.find((t) => t.id === themeId);
  if (!hit) throw new Error(`主题不存在: ${themeId}`);
  if (hit.name.includes(".")) {
    const label = resolve(hit.name);
    if (!label) throw new Error(`主题名 key 未解析出来: ${hit.name}`);
    return label;
  }
  return hit.name;
}
