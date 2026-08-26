// 注册表 settings 槽展示分组(tabs)投影测试 —— 多内核设置页合并的机制层(设计 §3.1)。
// 验证:有 tabs 的贡献项是「入口」,递归投影成 SettingsItem,tabs 子项 pluginId 随父继承、
// configFile/saveMode 各自独立(只合并展示,不合并 config)。
import { describe, it, expect } from "vitest";
import { PluginRegistry } from "./registry";
import type { DiscoveredPlugin } from "./discover";

function plugin(manifest: DiscoveredPlugin["manifest"]): DiscoveredPlugin {
  return { manifest, path: "/tmp/plugin", source: "builtin" };
}

describe("settingsItems 展示分组投影", () => {
  it("有 tabs 的入口递归投影,pluginId 随父继承", () => {
    const reg = new PluginRegistry();
    reg.registerOne(plugin({
      id: "pi-manager",
      version: "1.0.0",
      contributes: {
        settings: [
          {
            id: "pi",
            title: "Pi",
            icon: "pi",
            tabs: [
              { id: "pi-kernel", title: "Pi", component: "PiManagerPage", configFile: "~/.pi/agent/settings.json" },
              { id: "pi-ext", title: "PI 拓展", component: "ExtensionManagerPage", saveMode: "manual" },
              { id: "pi-models", title: "模型", component: "ModelManagerPage", configFile: "~/.pi/agent/models.json" },
            ],
          },
        ],
      },
    }));

    const items = reg.settingsItems();
    expect(items).toHaveLength(1);
    const entry = items[0];
    expect(entry.id).toBe("pi");
    expect(entry.tabs).toHaveLength(3);
    expect(entry.tabs!.map((t) => t.id)).toEqual(["pi-kernel", "pi-ext", "pi-models"]);
    // pluginId 继承:三个 TAB 都归 pi-manager,不各自新开 pluginId
    expect(entry.tabs!.every((t) => t.pluginId === "pi-manager")).toBe(true);
    // configFile 各自独立:入口是壳(无 configFile),TAB 各带各的
    expect(entry.configFile).toBeNull();
    expect(entry.tabs![0].configFile).toBe("~/.pi/agent/settings.json");
    expect(entry.tabs![1].saveMode).toBe("manual");
    expect(entry.tabs![2].configFile).toBe("~/.pi/agent/models.json");
  });

  it("无 tabs 的普通项保持原样", () => {
    const reg = new PluginRegistry();
    reg.registerOne(plugin({
      id: "theme-manager",
      version: "1.0.0",
      contributes: { settings: [{ id: "themes", title: "主题", component: "ThemePage", saveMode: "manual" }] },
    }));
    const items = reg.settingsItems();
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("themes");
    expect(items[0].tabs).toBeUndefined();
    expect(items[0].pluginId).toBe("theme-manager");
  });
});
