// @vitest-environment jsdom
// PluginIcon / resolvePluginIcon 的**表外取值**与**两套兜底语义**断言（r242；按 r241 的通则）。
//
// ## 钉的性质
//
// 图标名是**契约字段**（来自任意插件的 manifest / 内核注册表），而 ICONS 是本文件内部的
// **兜底呈现表**——表里没有的名字必然会出现（任何第三方插件都能声明一个新名字）。
// 两者的容错方向相反（r241）：表可以缺项，契约字段不能因为表缺项就崩或静默消失。
//
// ① `PluginIcon`：表外名字 ⇒ **回落 Puzzle**（渲染出图标，不是什么都不渲染）；
// ② `PluginIcon`：表内名字 ⇒ 渲染对应图标（不是回落）；
// ③ `resolvePluginIcon`：表外名字 ⇒ **返回 null**（组件注释明写：
//    "消费方自己定回退，不吃 PluginIcon 的 Puzzle 兜底"）——**两套 API 的兜底语义必须不同**，
//    若哪天被"统一"成一样，消费方就会拿到意外的 Puzzle 或意外的空白；
// ④ `PluginIcon`：名字命中内核注册表（window.kernel.kernelIds）⇒ 委托 KernelLogo，
//    判据是**注册表清单**而不是写死内核名（§1.4 内核无特权：加第四个内核不用改这里）。
//
// ⚠ 断言"渲染出了 svg / 没有崩"，不断言具体图标形状（那是 lucide 的实现细节，不是本组件的契约）。

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render } from "@testing-library/react";
import { PluginIcon, resolvePluginIcon } from "./plugin-icon";

beforeEach(() => {
  // ④ 那条要单独给注册表；其余用例给空清单，避免走到 KernelLogo（它依赖更多 window.kernel 面）
  (window as unknown as { kernel: { kernelIds: string[] } }).kernel = { kernelIds: [] };
});

describe("PluginIcon：表外名字仍守住契约（回落而不是崩/空白）", () => {
  it("① 表外名字 ⇒ 渲染出图标（Puzzle 兜底），不是什么都不渲染", () => {
    const { container } = render(<PluginIcon name="someThirdPartyIconName" />);
    expect(container.querySelector("svg"), "未知图标名仍要渲染出一个 svg（Puzzle 兜底）").not.toBeNull();
  });

  it("② 表内名字 ⇒ 渲染出图标（与表外同样是 svg，但走的是表内分支）", () => {
    const { container } = render(<PluginIcon name="settings" />);
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("③ resolvePluginIcon 的兜底语义**与 PluginIcon 不同**：表外 ⇒ null（消费方自己定回退）", () => {
    expect(resolvePluginIcon("someThirdPartyIconName"),
      "组件注释明写：未知名返回 null，不吃 PluginIcon 的 Puzzle 兜底").toBeNull();
    expect(resolvePluginIcon("settings"), "表内名字要返回组件本身").toBeTruthy();
  });

  // ⚠ r242 如实记：原本还有一条 ④「名字命中内核注册表 ⇒ 委托 KernelLogo」，本轮**撤掉**——
  //   KernelLogo 的 logo 面来自 zustand 的 kernel-logos store（不是 window.kernel），
  //   要断言委托分支就得先种那个 store；而"委托判据用注册表清单而不是写死内核名"这条
  //   已由 audit 的检验⑥/⑬（内核名字面量与字面量键访问）与 kernel-logo 自己的关注面覆盖。
  //   按 r226 的教训（mock 的面要照组件真实用到的面给，不能按印象列），
  //   与其给一个半对的夹具，不如撤掉并记下来（下一轮若要补，先读 kernel-logos store 的形状）。
});
