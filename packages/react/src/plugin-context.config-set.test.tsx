// @vitest-environment jsdom
// `ctx.config.set` 的框架级失败兜底（r82 建、r90 补精确证据）。
//
// ## 为什么需要这一层测试
//
// r87 的 `write-failure-feedback.e2e.mjs` 已在真机上证明了**整条链路**通
// （服务端 throw → gateway 转 HANDLER_ERROR → transport reject → renderer `.catch`
// → `announceTransient` → 常驻 live region(role=alert) + 可见文本），
// 但它走的是**布局持久化**那一条（`writeGeneralConfig`）。
// r82 给 `ctx.config.set` 加的框架兜底是**另一条支路**，而 r88/r89 两轮试图在真机上触发它
// 都没成功（设置页导航在隐藏窗口里点不动；而 voice-input 等其它调用方同样难触达）。
//
// 所以本测试在 **DOM 层**精确钉住这条支路的三个性质：
//   ① 失败时**用户可见**（live region 里出现 role=alert 的播报，含真实原因）；
//   ② 文案是**译文**而不是裸 i18n 键（用真实语言包初始化 i18next，r54/r56/r78 的纪律：
//      给测试真字典，不软化断言、不改写成断言键名）；
//   ③ **仍然 reject**（不吞掉）——否则那些自己写了 try/catch 的调用方会以为成功了
//      （r82 的设计决定之一：兜底只负责"让用户看见"，不改变控制流语义）。
//
// ⚠ 这一层测的是"框架兜底本身"，不替代 r87 的真机剧本：真机剧本证明**传输链路**通，
//   本测试证明**这一支的兜底逻辑**对。两者互补，缺一个都留死角。

import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import i18next from "i18next";
import { PluginIdContext, usePluginContext } from "./index";

const HERE = dirname(fileURLToPath(import.meta.url));
// 语言包文件是**带 ns 前缀的扁平键**（"shell.configWriteFailed": …），
// 而 merge 的规则是「第一个 dot 前是 namespace、其余按 dot 分层嵌套」（r78 踩过这个坑），
// 所以要按同一规则整形后再喂给 i18next。
const flat = JSON.parse(
  // ⚠ packages/react/src → 仓库根是 **3** 级（首版写 2 级 ⇒ 读到 packages/src/… 报 ENOENT；r57 同款错）
  readFileSync(join(HERE, "../../../src/plugins/system/i18n/locales/zh-CN/shell.json"), "utf-8"),
) as Record<string, string>;
const SHELL_NS: Record<string, string> = {};
for (const [k, v] of Object.entries(flat)) {
  const dot = k.indexOf(".");
  SHELL_NS[dot > 0 ? k.slice(dot + 1) : k] = v;
}

/** 一个最小的消费者：拿到 ctx 后调用 config.set，把结果/异常都暴露给断言。 */
function Probe({ onDone }: { onDone: (r: { rejected: boolean; message: string }) => void }): React.ReactElement {
  const ctx = usePluginContext();
  return (
    <button
      data-probe="write"
      onClick={() => {
        void ctx.config.set("someKey", { a: 1 })
          .then(() => onDone({ rejected: false, message: "" }))
          .catch((e: unknown) => onDone({ rejected: true, message: (e as Error).message }));
      }}
    >
      write
    </button>
  );
}

describe("ctx.config.set 的框架级失败兜底（r82）", () => {
  let setMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    // 真实 i18next 单例 + 真实语言包（不是 mock t）
    if (!i18next.isInitialized) {
      await i18next.init({
        lng: "zh-CN",
        fallbackLng: "en",
        defaultNS: "shell",
        ns: ["shell"],
        nsSeparator: ".",
        keySeparator: ".",
        interpolation: { escapeValue: false, prefix: "{{", suffix: "}}" },
        returnEmptyString: false,
        resources: { "zh-CN": { shell: SHELL_NS } },
      });
    }
    // window.kernel 的最小桩：config.set 拒绝（模拟服务端 handler 抛错 ⇒ transport reject）
    setMock = vi.fn().mockRejectedValue(new Error("EACCES: permission denied, open '/x/config/probe.json'"));
    // window.kernel 的桩：`config` 用精确桩（本测试的对象），其余属性用**宽容 Proxy**兜住
    // （usePluginContext 在构造期会触碰多个 API 面；逐个枚举既啰嗦又会在发布面新增面时假红）。
    // ⚠ Proxy 只对"本测试不关心的面"宽容；被断言的 config.set 是显式桩，不受 Proxy 影响。
    const touched = new Set<string>();
    const permissive = (): unknown => new Proxy(function () { /* callable */ } as unknown as Record<string, unknown>, {
      get(_t, prop) {
        if (typeof prop === "string") touched.add(prop);
        return permissive();
      },
      apply() { return Promise.resolve(undefined); },
    });
    (window as unknown as { kernel: unknown }).kernel = new Proxy({} as Record<string, unknown>, {
      get(_t, prop) {
        if (prop === "config") {
          return {
            get: vi.fn().mockResolvedValue(undefined),
            set: setMock,
            all: vi.fn().mockResolvedValue({}),
            getScope: vi.fn().mockResolvedValue({}),
          };
        }
        if (typeof prop === "string") touched.add(prop);
        return permissive();
      },
    });
    (globalThis as unknown as { __touched?: Set<string> }).__touched = touched;
    document.body.innerHTML = "";
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it("判据不空转：真实语言包里确有这条文案，且不是键名", () => {
    const text = SHELL_NS["configWriteFailed"];
    expect(text, "shell.json 里必须有 configWriteFailed（否则本测试是在断言一个不存在的键）").toBeTruthy();
    expect(text).toContain("{{detail}}");
    expect(text).not.toBe("shell.configWriteFailed");
  });

  it("① 写盘失败时用户可见：live region 里出现 role=alert 的播报，且带真实原因", async () => {
    render(<PluginIdContext.Provider value="probe-plugin"><Probe onDone={() => {}} /></PluginIdContext.Provider>);
    const btn = document.querySelector('[data-probe="write"]') as HTMLButtonElement;
    btn.click();
    await waitFor(() => {
      const alert = document.querySelector('[data-announced="error"]');
      expect(alert, "失败后必须往常驻 live region 里插一条播报（announceTransient）").not.toBeNull();
      expect(alert!.getAttribute("role"), "错误必须用可打断的 role=alert（r59/r61：播报强度属于语义）").toBe("alert");
      expect(alert!.textContent, "播报内容要含真实原因，否则用户不知道为什么失败").toContain("EACCES");
    });
  });

  it("② 播报的是**译文**而不是裸 i18n 键", async () => {
    render(<PluginIdContext.Provider value="probe-plugin"><Probe onDone={() => {}} /></PluginIdContext.Provider>);
    (document.querySelector('[data-probe="write"]') as HTMLButtonElement).click();
    await waitFor(() => {
      const alert = document.querySelector('[data-announced="error"]');
      expect(alert).not.toBeNull();
      expect(alert!.textContent, "不得出现裸键（出现即 i18next 没查到 ⇒ 字典形状或键名错了）")
        .not.toContain("shell.configWriteFailed");
      expect(alert!.textContent, "应以真实译文开头").toContain(SHELL_NS["configWriteFailed"].split("{{detail}}")[0].trim());
    });
  });

  it("③ 兜底后**仍然 reject**（不吞掉）：自己写了 try/catch 的调用方必须还能感知失败", async () => {
    const onDone = vi.fn();
    render(<PluginIdContext.Provider value="probe-plugin"><Probe onDone={onDone} /></PluginIdContext.Provider>);
    (document.querySelector('[data-probe="write"]') as HTMLButtonElement).click();
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    const arg = onDone.mock.calls[0][0] as { rejected: boolean; message: string };
    expect(arg.rejected, "兜底不得吞掉 rejection——否则调用方的 catch 分支永不触发，会以为写成功了").toBe(true);
    expect(arg.message).toContain("EACCES");
    expect(setMock).toHaveBeenCalledTimes(1);
  });
});
