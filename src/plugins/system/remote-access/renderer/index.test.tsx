// @vitest-environment jsdom
// remote-access 设置页的**装载三态**断言（r223；钉住 r222 那次改动）。
//
// ## 钉的性质（r143 的空态分语义 + r222 的三通道判据）
//
// 设备列表有三种状态，**必须能被用户区分**：
// ① 装载失败 ⇒ `role=alert` 的失败提示（文案明说"这不是暂无设备，而是没读到"）；
// ② 装载成功但为空 ⇒ 普通的"暂无设备"（无 alert）；
// ③ 装载成功且有数据 ⇒ 设备行。
// 此前 ① 与 ② 渲染成同一个"暂无设备"，用户无从知道是"确实没有"还是"没读到"（§7.6 不静默）。
//
// 另外断言 status/qr 的装载失败会在页顶出 `role=alert`（用户主动看这一页时要能看懂），
// 以及**成功后失败态被清除**（事件驱动刷新会把旗标擦掉，不能一直挂着红字）。
//
// ⚠ 不 mock @my-harness-desktop/react：Button/SettingsSection 用真实现渲染，
//   这样断言的是**真实 DOM**（§5.6 第二级）；只 mock react-i18next（t 返回键名，
//   便于按键断言；r124 的纪律是断言真文案，但本插件的文案由语言包供、
//   测试关心的是"哪一态被渲染"，用键名做锚更稳，且死键守卫另行保证键存在）。

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string, v?: Record<string, unknown>) => (v ? `${k}:${JSON.stringify(v)}` : k), i18n: { language: "zh-CN" } }),
}));

type Remote = {
  status: () => Promise<unknown>;
  qr: () => Promise<unknown>;
  connections: () => Promise<unknown>;
  onStateChanged: (cb: () => void) => () => void;
  onConnectionsChanged?: (cb: (l: unknown) => void) => () => void;
};
function installRemote(r: Partial<Remote>): void {
  const stub: Remote = {
    status: async () => ({ enabled: true, bind: "lan", port: 8787, lanUrls: ["http://127.0.0.1:8787"] }),
    qr: async () => "data:image/png;base64,AAA",
    connections: async () => [],
    onStateChanged: () => () => {},
    onConnectionsChanged: undefined,
    ...r,
  };
  (window as unknown as { kernel: { remote: Remote } }).kernel = { remote: stub };
}

beforeEach(() => { vi.clearAllMocks(); });

async function load() {
  const { RemoteAccessPage } = await import("./index");
  return render(<RemoteAccessPage />);
}

describe("remote-access：装载三态可区分（空 ≠ 装载失败）", () => {
  it("① 设备装载失败 ⇒ 出 role=alert 的失败提示，且不显示'暂无设备'", async () => {
    installRemote({ connections: () => Promise.reject(new Error("transport gone")) });
    await load();
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    const alerts = screen.getAllByRole("alert").map((n) => n.textContent ?? "");
    expect(alerts.some((x) => x.includes("remote.devicesLoadFailed")),
      "设备装载失败要有专属提示（r222）：" + JSON.stringify(alerts)).toBe(true);
    expect(screen.queryByText("remote.noDevices"),
      "装载失败时不该显示'暂无设备'（那会把失败伪装成空态，r143）").toBeNull();
  });

  it("② 装载成功但列表为空 ⇒ 显示'暂无设备'，且没有失败提示", async () => {
    installRemote({ connections: async () => [] });
    await load();
    await waitFor(() => expect(screen.getByText("remote.noDevices")).toBeTruthy());
    expect(screen.queryByText("remote.devicesLoadFailed"), "空列表不该被报成装载失败").toBeNull();
  });

  it("③ 装载成功且有设备 ⇒ 渲染设备行（不是空态也不是失败态）", async () => {
    installRemote({
      connections: async () => ([{ id: "dev-1", kind: "remote", authenticated: true, remoteAddress: "10.0.0.7", connectedAt: 1 }]),
    });
    await load();
    await waitFor(() => expect(screen.queryByText("remote.noDevices")).toBeNull());
    expect(screen.queryByText("remote.devicesLoadFailed")).toBeNull();
    expect(screen.getByText(/10\.0\.0\.7/), "设备地址应出现在列表里（有数据态；DeviceRow 的真实形状是 id/kind/authenticated/remoteAddress，首版夹具按 label 猜错了）").toBeTruthy();
  });

  it("④ status/qr 都装载失败 ⇒ 页顶出合并的失败提示（用户主动看这页时要能看懂）", async () => {
    installRemote({
      status: () => Promise.reject(new Error("no route")),
      qr: () => Promise.reject(new Error("no route")),
    });
    await load();
    await waitFor(() => expect(screen.getByText("remote.statusAndQrLoadFailed")).toBeTruthy());
    expect(screen.getByText("remote.statusAndQrLoadFailed").closest("[role=alert]"),
      "失败提示要挂在 role=alert 上（读屏可打断，r202/r222）").toBeTruthy();
  });

  it("⑤ 只有 qr 失败 ⇒ 提示 qr 那一条（不谎报 status 也失败）", async () => {
    installRemote({ qr: () => Promise.reject(new Error("qr boom")) });
    await load();
    await waitFor(() => expect(screen.getByText("remote.qrLoadFailed")).toBeTruthy());
    expect(screen.queryByText("remote.statusLoadFailed"), "status 成功时不该报它失败").toBeNull();
    expect(screen.queryByText("remote.statusAndQrLoadFailed")).toBeNull();
  });
});
