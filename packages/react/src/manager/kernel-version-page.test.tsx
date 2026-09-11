// @vitest-environment jsdom
// KernelVersionPage 的**能力驱动显式降级**守卫（§7.6 三分法第三档）。
//
// 背景：随壳分发的内置内核（minimal）没有"安装/切换版本"这回事，也没有"自定义内核目录"。
// 此前这个共享 base 不看能力、照样把两个控件画出来 —— 用户点下去只会得到一句错误，
// 而"点了没用的控件"比"没有这个控件"更糟：它像承诺。
//
// 现在的判据是**数据**（`api.capabilities()`），不是内核身份分支：
// 加第四个内核只填它自己的旗标，本页零改动。这组守卫钉三件事：
//   ① 不支持 → 安装相关的控件与"最新版本/检查更新"行**不渲染**，并给一句"为什么没有"的说明；
//   ② 支持 → 照常渲染（降级不能把正常内核也一起关掉）；
//   ③ 能力还没问到（Promise 未 resolve）→ 先按"不支持"渲染，不闪出一个用不了的按钮。
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => ({
  caps: { install: true, customDir: true } as { install: boolean; customDir: boolean },
  status: {
    currentVersion: "1.2.3" as string | null,
    installedVersion: "1.2.3" as string | null,
    available: true,
    source: "installed" as "installed" | "custom",
    customCliDir: "",
    error: null as string | null,
  },
}));

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
// CustomCliSection 要一个 PluginContext（只用 dialog.openDirectory）——给最小可用面，不造整套 mock。
vi.mock("../plugin-context", () => ({ usePluginContext: () => ({ dialog: { openDirectory: async () => null } }) }));

import { KernelVersionPage } from "./kernel-version-page";

/** 最小 KernelVersionApi 替身：能力/版本清单都由用例控制。 */
function api(over: { caps?: { install: boolean; customDir: boolean }; versions?: string[] } = {}) {
  h.caps = over.caps ?? { install: true, customDir: true };
  const versions = over.versions ?? ["1.2.3", "1.3.0"];
  return {
    // 永不 resolve 的 abilities 用来测"还没问到"那一态
    capabilities: () => (over.caps === undefined ? new Promise<never>(() => {}) : Promise.resolve(h.caps)),
    status: () => Promise.resolve(h.status),
    listVersions: () => Promise.resolve({ versions, latest: versions[versions.length - 1] ?? null }),
    install: () => Promise.resolve({ ok: true, error: null }),
    setCustomCliDir: () => Promise.resolve({ ok: true, error: null, pendingCount: 0, status: h.status }),
  };
}

beforeEach(() => {
  h.status = { currentVersion: "1.2.3", installedVersion: "1.2.3", available: true, source: "installed", customCliDir: "", error: null };
});

describe("KernelVersionPage:内置内核（不支持安装）显式降级", () => {
  it("不渲染安装区与「最新版本/检查更新」行，并给出「为什么没有」的说明", async () => {
    render(<KernelVersionPage api={api({ caps: { install: false, customDir: false } }) as never} i18nPrefix="minimal" />);
    // 等能力到达后重渲染
    await screen.findByText("minimal.noInstallHint");
    expect(screen.queryByText("minimal.installSwitch"), "内置内核不该画出用不了的安装区").toBeNull();
    expect(screen.queryByText("minimal.latestVersion"), "没有版本源就不该显示「最新版本」").toBeNull();
    expect(screen.queryByText("minimal.checkUpdate")).toBeNull();
    // 自定义目录区也一起藏（同一份能力数据）
    expect(screen.queryByText("minimal.customCli.title")).toBeNull();
  });

  it("支持安装的内核照常渲染（降级不能误伤）", async () => {
    render(<KernelVersionPage api={api({ caps: { install: true, customDir: true } }) as never} i18nPrefix="kernel" />);
    await screen.findByText("kernel.latestVersion");
    expect(screen.getByText("kernel.installSwitch")).toBeInTheDocument();
    expect(screen.getByText("kernel.customCli.title")).toBeInTheDocument();
  });

  it("能力还没问到 → 先按不支持渲染（不闪出一个点不动的按钮）", async () => {
    // capabilities() 永不 resolve
    render(<KernelVersionPage api={api({ caps: undefined }) as never} i18nPrefix="kernel" />);
    await waitFor(() => expect(screen.getByText("kernel.installedVersion")).toBeInTheDocument());
    expect(screen.queryByText("kernel.installSwitch"), "能力未知时先闪出安装按钮，用户点了才发现用不了").toBeNull();
  });

  it("状态文案：不支持安装时读的是「内置」而不是 common.unknown", async () => {
    render(<KernelVersionPage api={api({ caps: { install: false, customDir: false } }) as never} i18nPrefix="minimal" />);
    await screen.findByText("minimal.noInstallHint");
    expect(screen.getByText("minimal.upToDate"), "状态落到 common.unknown 会被读成「查不到」，真相是「没有版本这回事」").toBeInTheDocument();
    expect(screen.queryByText("common.unknown")).toBeNull();
  });
});
