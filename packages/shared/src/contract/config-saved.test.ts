// `configSavedKind` / `configSavedPayload` —— 设置页保存广播的语义派生（圆心纯函数）。
//
// 为什么值得单测：它是**发送方与消费方的共同判据**（§1.3 契约单源）。
// 派生错了，症状是"保存了但消费方不刷新"——静默失效、无报错，
// 正是 r33 之前那个缺陷的形态（timeline 拿路径比对 `~/.pi/agent/models.json`，
// 换个内核路径就不匹配，模型清单于是不刷新）。
// 纯函数、零依赖（§4.5：不需要 mock 的就是内层材料），裸单测最合适。

import { describe, it, expect } from "vitest";
import { configSavedKind, configSavedPayload } from "./config-saved";

describe("configSavedKind：从贡献声明派生语义分类", () => {
  it("声明了 kernelModels → kernelModels（模型清单要重探）", () => {
    expect(configSavedKind({ kernelModels: "pi" })).toBe("kernelModels");
    expect(configSavedKind({ kernelModels: "dsh" })).toBe("kernelModels");
    // ★ 任何内核 id 都同样派生——判据只认"有没有声明这个面"，不认是哪个内核
    expect(configSavedKind({ kernelModels: "minimal" })).toBe("kernelModels");
    expect(configSavedKind({ kernelModels: "some-fourth-kernel" })).toBe("kernelModels");
  });

  it("声明了 kernelConfig → kernelConfig", () => {
    expect(configSavedKind({ kernelConfig: "pi" })).toBe("kernelConfig");
    expect(configSavedKind({ kernelConfig: "whatever-kernel" })).toBe("kernelConfig");
  });

  it("两者都没声明 → pluginConfig（壳的分层配置空间里的普通插件配置）", () => {
    expect(configSavedKind({})).toBe("pluginConfig");
    expect(configSavedKind(null)).toBe("pluginConfig");
    expect(configSavedKind(undefined)).toBe("pluginConfig");
  });

  it("两个面都声明时 kernelModels 优先（模型清单重探是更强的动作，不能被 weaker 分类吞掉）", () => {
    expect(configSavedKind({ kernelModels: "pi", kernelConfig: "pi" })).toBe("kernelModels");
  });

  it("空字符串的声明按未声明处理（falsy 不算声明）", () => {
    expect(configSavedKind({ kernelModels: "" })).toBe("pluginConfig");
    expect(configSavedKind({ kernelConfig: "" })).toBe("pluginConfig");
  });
});

describe("configSavedPayload：payload 与派生同源", () => {
  it("保留 path（老消费方/日志仍可用）并带上派生出的 kind", () => {
    expect(configSavedPayload("~/.my-harness-desktop/config/general.json", {})).toEqual({
      path: "~/.my-harness-desktop/config/general.json",
      kind: "pluginConfig",
    });
    expect(configSavedPayload("/any/where/models.json", { kernelModels: "x" })).toEqual({
      path: "/any/where/models.json",
      kind: "kernelModels",
    });
  });

  it("★ 派生**不依赖路径**：同一个 kind 可以来自任何路径（这正是去掉路径常量比对的意义）", () => {
    // 旧判据是 `path === "~/.pi/agent/models.json"`；换个内核的路径就判不出来。
    // 现在路径与语义解耦：只要声明了 kernelModels，无论文件在哪都派生出同一个 kind。
    const paths = ["~/.pi/agent/models.json", "~/.dsh/settings.yaml", "~/.minimal/agent/models.json", "/tmp/fourth/models.json"];
    for (const p of paths) expect(configSavedPayload(p, { kernelModels: "k" }).kind).toBe("kernelModels");
  });
});
