// `resolveBootPaths` 的单测 —— 纯函数，环境全部注入，不需要 mock（§4.5 判据）。
//
// 断言逐项对照设计文档 §2.4.4 的 dev/打包态路径对照表。这张表今天散在 `assemble.ts` 三处
// （L85-102 / L145-157 / L190-203），中间夹着 200 行别的逻辑，所以从来没有测试覆盖过——
// 打包态路径写错的症状是"安装版里某个功能没有"，而 dev 态怎么跑都正常（`packaging-paths.test.ts`
// 的文件头记的就是这个教训）。抽成纯函数之后它可以被逐条钉住。
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { resolveBootPaths, DEFAULT_PORT, type BootPathEnv } from "./context";

const DEV: BootPathEnv = {
  isPackaged: false, homeDir: "/home/u", cwd: "/repo", resourcesPath: "/ignored",
};
const PKG: BootPathEnv = {
  isPackaged: true, homeDir: "/home/u", cwd: "/home/u", resourcesPath: "/app/resources",
};

describe("resolveBootPaths：dev 态", () => {
  const p = resolveBootPaths(DEV);

  it("数据根是 -dev 后缀（与打包态物理隔离，dev 跑测试不污染真实 profile）", () => {
    expect(p.dataRoot).toBe("/home/u/.my-harness-desktop-dev");
    expect(p.configDir).toBe("/home/u/.my-harness-desktop-dev/config");
  });

  it("内置壳插件根 = 仓库 src/plugins（dev 态直接扫源码目录）", () => {
    expect(p.builtinPluginsDir).toBe(join("/repo", "src/plugins"));
  });

  it("内核产物根与启动步骤根都在 <cwd>/out/main 下（dev 态也跑构建产物，不是 src）", () => {
    expect(p.kernelBuildRoot).toBe(join("/repo", "out/main/server/kernel"));
    expect(p.bootStepsRoot).toBe(join("/repo", "out/main/boot/steps"));
  });

  it("内置技能源 = 仓库 .claude/skills，贴纸源 = 仓库 assets/stickers", () => {
    expect(p.bundledSkillsSource).toBe(join("/repo", ".claude/skills"));
    expect(p.bundledStickersSource).toBe(join("/repo", "assets/stickers"));
  });

  it("镜像目的地在数据根下（受管目录，强制覆盖）", () => {
    expect(p.bundledSkillsDir).toBe("/home/u/.my-harness-desktop-dev/skills");
    expect(p.bundledStickersDir).toBe("/home/u/.my-harness-desktop-dev/stickers/bundled");
  });

  it("项目级插件根跟 cwd 走（dev 态 cwd = 仓库根，与用户级不同目录）", () => {
    expect(p.projectPluginsDir).toBe(join("/repo", ".my-harness-desktop/plugins"));
    expect(p.projectPluginsDir).not.toBe(p.userPluginsDir);
  });
});

describe("resolveBootPaths：打包态", () => {
  const p = resolveBootPaths(PKG);

  it("数据根无 -dev 后缀", () => {
    expect(p.dataRoot).toBe("/home/u/.my-harness-desktop");
  });

  it("内置壳插件/技能/贴纸都从 resources/ 取（随壳分发的 extraResources）", () => {
    expect(p.builtinPluginsDir).toBe(join("/app/resources", "my-harness-desktop-builtin"));
    expect(p.bundledSkillsSource).toBe(join("/app/resources", "my-harness-desktop-skills"));
    expect(p.bundledStickersSource).toBe(join("/app/resources", "my-harness-desktop-stickers"));
  });

  it("内核产物根与启动步骤根都在 app.asar 内（动态 require / readdirSync 的目标）", () => {
    expect(p.kernelBuildRoot).toBe(join("/app/resources", "app.asar/out/main/server/kernel"));
    expect(p.bootStepsRoot).toBe(join("/app/resources", "app.asar/out/main/boot/steps"));
  });

  it("打包态 cwd 通常是家目录 → 项目级插件根与用户级插件根是**同一个物理目录**", () => {
    // 这不是 bug 而是既有行为（assemble.ts:200-201 称"降级为另一个用户级"）：
    // 等效于同一根被扫两次，registerAll 的覆盖去重吸收重复。测试把这条事实钉住，
    // 免得将来有人"顺手修掉"却改变了插件优先级语义。
    expect(p.projectPluginsDir).toBe(p.userPluginsDir);
    expect(p.projectPluginsDir).toBe("/home/u/.my-harness-desktop/plugins");
  });

  it("dev 与打包态的数据根不同（同一台机器上两者可并存）", () => {
    expect(resolveBootPaths(DEV).dataRoot).not.toBe(p.dataRoot);
  });
});

describe("resolveBootPaths：纯函数性质", () => {
  it("同样输入产出同样结果，且不读任何全局环境（改 process.cwd 不影响）", () => {
    const before = resolveBootPaths(DEV);
    const originalCwd = process.cwd;
    process.cwd = () => "/totally/different";
    try {
      expect(resolveBootPaths(DEV)).toEqual(before);
    } finally {
      process.cwd = originalCwd;
    }
  });

  it("resourcesPath 在 dev 态不参与任何路径（分流只看 isPackaged）", () => {
    const a = resolveBootPaths({ ...DEV, resourcesPath: "/x" });
    const b = resolveBootPaths({ ...DEV, resourcesPath: "/y" });
    expect(a).toEqual(b);
  });
});

describe("端口解析规则", () => {
  it("缺省端口是 8420（常量导出，供 createBootContext 与测试共用单源）", () => {
    expect(DEFAULT_PORT).toBe(8420);
  });
});
