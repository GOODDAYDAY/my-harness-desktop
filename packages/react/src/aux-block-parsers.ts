// aux-block-parsers.ts —— 块解析器注册表(renderer 侧)。
//
// plugins-host 加载插件 module 时收集 mod.auxParsers 进本注册表(与 channels 同模式);
// timeline 的 blocks.ts 经 getAuxParsers() 拿全部解析器喂 parseUserBlocks。
// 解析器是纯函数,卸载插件后残留的无害(不匹配任何新文本),unload 时一并清。
import type { AuxBlockParser } from "@pi-desktop/contract";

const parsers: AuxBlockParser[] = [];

export function registerAuxParsers(ps: AuxBlockParser[]): void {
  for (const p of ps) {
    const idx = parsers.findIndex((x) => x.id === p.id);
    if (idx >= 0) parsers[idx] = p;
    else parsers.push(p);
  }
}

export function unregisterAuxParsers(ids: string[]): void {
  for (let i = parsers.length - 1; i >= 0; i--) {
    if (ids.includes(parsers[i].id)) parsers.splice(i, 1);
  }
}

export function getAuxParsers(): AuxBlockParser[] {
  return parsers;
}
