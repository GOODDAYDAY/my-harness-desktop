import { afterEach, describe, expect, it } from "vitest";
import { eventBus } from "@my-harness-desktop/react";

// eventBus 单例,测试间用唯一 pluginId 隔离,测完 unregister 清理。
const PLUGIN = "test-event-bus-list";

afterEach(() => {
  eventBus.unregisterPlugin(PLUGIN);
});

describe("eventBus.listChannels", () => {
  it("列出注册的 channel 与归属插件", () => {
    eventBus.registerChannels(PLUGIN, ["test:a", "test:b"]);
    const list = eventBus.listChannels();
    expect(list).toEqual(
      expect.arrayContaining([
        { channel: "test:a", pluginId: PLUGIN },
        { channel: "test:b", pluginId: PLUGIN },
      ]),
    );
  });

  it("channelMeta 随注册收集,无 meta 的 channel 不含 meta 字段", () => {
    eventBus.registerChannels(PLUGIN, ["test:a", "test:b"], {
      "test:a": { label: "甲", description: "描述", payloadExample: { x: 1 } },
    });
    const list = eventBus.listChannels();
    const a = list.find((c) => c.channel === "test:a");
    const b = list.find((c) => c.channel === "test:b");
    expect(a?.meta).toEqual({ label: "甲", description: "描述", payloadExample: { x: 1 } });
    expect(a?.pluginId).toBe(PLUGIN);
    expect(b?.meta).toBeUndefined();
    expect("meta" in (b as object)).toBe(false);
  });

  it("不包含 system:* 框架事件", () => {
    eventBus.emitSystem("system:testOnly", {});
    const list = eventBus.listChannels();
    expect(list.some((c) => c.channel === "system:testOnly")).toBe(false);
  });

  it("插件卸载后条目消失(动态性)", () => {
    eventBus.registerChannels(PLUGIN, ["test:gone"]);
    expect(eventBus.listChannels().some((c) => c.channel === "test:gone")).toBe(true);
    eventBus.unregisterPlugin(PLUGIN);
    expect(eventBus.listChannels().some((c) => c.channel === "test:gone")).toBe(false);
  });

  it("重复注册同一 channel 幂等,meta 可后补", () => {
    eventBus.registerChannels(PLUGIN, ["test:dup"]);
    eventBus.registerChannels(PLUGIN, ["test:dup"], { "test:dup": { label: "后补" } });
    const c = eventBus.listChannels().find((x) => x.channel === "test:dup");
    expect(c?.meta?.label).toBe("后补");
    expect(eventBus.listChannels().filter((x) => x.channel === "test:dup").length).toBe(1);
  });
});
