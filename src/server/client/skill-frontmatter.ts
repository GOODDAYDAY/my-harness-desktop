// skill-frontmatter —— pi/dsh 共用的 SKILL.md frontmatter 单字段手术式改写。
//
// setModelInvocable 轴在两个内核都是「改 frontmatter 的 disable-model-invocation 字段」,
// 这段纯函数从 pi-skill-provider 抽出共享(§1.1 气味三:同一逻辑多个入口各写一遍是违规)。
// 保留注释、字段顺序、body 空白,不整体重排 YAML。
export function setFrontmatterField(content: string, key: string, value: string): string {
  const nl = content.includes("\r\n") ? "\r\n" : "\n";
  if (!content.startsWith("---")) {
    return `---${nl}${key}: ${value}${nl}---${nl}${nl}${content}`;
  }
  const openEnd = content.indexOf(nl, 0) + nl.length;
  let closeIdx = content.indexOf(`${nl}---`, openEnd - nl.length);
  if (closeIdx === -1) {
    return `---${nl}${key}: ${value}${nl}---${nl}${nl}${content}`;
  }
  if (content[closeIdx - 1] === "\r") closeIdx -= 1;
  const block = content.slice(openEnd, closeIdx);
  const fieldRe = new RegExp(`(^|\\n)([ \\t]*${key}[ \\t]*:[^\\n\\r]*)`);
  const m = block.match(fieldRe);
  if (m && m.index !== undefined && m[1] !== undefined) {
    return (
      content.slice(0, openEnd + m.index) +
      m[1] +
      m[0].slice(m[1].length).replace(/:.*/u, `: ${value}`) +
      content.slice(openEnd + m.index + m[0].length)
    );
  }
  return content.slice(0, closeIdx) + `${nl}${key}: ${value}` + content.slice(closeIdx);
}
