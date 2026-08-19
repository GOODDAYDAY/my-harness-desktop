// skill-toggle —— 技能配置读取(壳层用例编排)。
//
// 旧方案的 toggle 逻辑(+/- pattern 写 settings.json、frontmatter 改写)已下沉到
// pi-skill-provider(内核适配器读/写自己的存储)。本文件只保留 readSettings 原语,
// 供 bundled-skills 的 ensure* 复用(读 settings.json 判断路径是否已挂)。
import { existsSync } from "node:fs";
import { readJsonFile } from "../config/config-file";

/** 读 settings.json(不存在/损坏返回空对象;经共享原语 readJsonFile)。 */
export async function readSettings(filePath: string): Promise<Record<string, unknown>> {
  if (!existsSync(filePath)) return {};
  try {
    return await readJsonFile(filePath);
  } catch {
    return {};
  }
}
