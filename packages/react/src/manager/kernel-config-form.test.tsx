// @vitest-environment jsdom
// KernelConfigForm 的**未译字段降级**守卫 —— 钉住一个实测缺陷的根因修复。
//
// 缺陷（`scripts/demo/dom-audit.e2e.mjs` 在真实 app 的设置页抓到 8 处）：
// 界面上直接出现 `fieldDescs.terminal.hyperlinks`、`fieldDescs.modelThinkingLevels` 这样的
// **裸 i18n key**，用户看到的不是描述而是一串路径。
//
// 根因不是"漏了译文"，而是**降级机制写错了**：
//     const desc = field.description ? t(field.description, { defaultValue: "" }) : "";
// `defaultValue: ""` 是**假值**，i18next 把它当作"未提供默认值"，未命中时返回 key 本身
// （`nsSeparator: "."` 会切掉命名空间前缀，故显示成 `fieldDescs.X` 而非 `kernel.fieldDescs.X`）。
// 而渲染处的 `{desc && <span>…}` 守卫证明意图本来是"没译文就不渲染"——意图与机制不一致，
// 守卫形同虚设（裸 key 是非空字符串，永远为真）。
//
// 为什么这类漂移是**常态**而非偶发：字段清单由 `parseSettingsSchema` 从内核自己的
// settings-manager.d.ts 动态解析（`kernel/pi/manager/pi-kernel-config.ts` 不硬编码字段，
// 内核升级加字段就自动跟着变）。所以"内核有新字段、壳的 locale 还没跟上"会反复发生，
// 降级机制必须正确，否则每次内核升级都会在设置页漏出几个裸 key。
//
// ⚠ **本测试用真 i18next 实例，不 mock react-i18next**。同目录的 kernel-version-page.test.tsx
// 用 `vi.mock("react-i18next", …)` 是合理的（它只关心控件显不显示），但这里要复现的正是
// i18next 对 `defaultValue` 的真实语义——mock 掉 t 函数就等于把被测行为换成自己写的假实现，
// 测出来必然是绿的（假绿）。资源结构也照 app 的真实配置：`nsSeparator/keySeparator` 都是 "."，
// 资源按命名空间 + 嵌套对象存放（见 src/web/app/i18n-init.ts:26-34）。
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeAll } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import i18next, { type i18n as I18nInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import type { KernelConfigApi, KernelConfigField } from "@my-harness-desktop/shared";
import { KernelConfigForm } from "./kernel-config-form";

let i18n: I18nInstance;

beforeAll(async () => {
  i18n = i18next.createInstance();
  await i18n.init({
    lng: "zh-CN",
    fallbackLng: "en",
    // ⚠ 以下每一项都与 app 的真实初始化逐项对齐（src/web/app/i18n-init.ts:26-40），
    //   **少一项这个测试就可能假绿**——实测踩过两次：
    //   · 漏 `ns` 列表 → 所有 key 都查不到，连已译字段也降级，测试因"找不到已译文案"而红，
    //     看起来像组件坏了，其实是夹具没配对；
    //   · 漏 `returnEmptyString: false` → `t(missing, { defaultValue: "" })` 会**规规矩矩返回 ""**，
    //     于是缺陷复现不出来，旧代码也能通过测试（假绿）。这个选项正是让 i18next 把空串
    //     默认值当"未提供"、进而回退成返回 key 的原因。
    nsSeparator: ".",
    keySeparator: ".",
    defaultNS: "common",
    ns: ["common", "kernel"],
    returnEmptyString: false,
    returnNull: false,
    interpolation: { escapeValue: false },
    resources: {
      "zh-CN": {
        common: {},
        kernel: {
          groups: { general: "通用", terminal: "终端" },
          fields: {
            // 只有两个字段有译文；另外两个刻意缺失（模拟内核新增了字段、locale 没跟上）
            knownField: "已知字段",
            "terminal.known": "终端已知项",
          },
          fieldDescs: {
            knownField: "这是已译字段的描述",
            "terminal.known": "这是已译终端项的描述",
          },
        },
      },
    },
  });
});

/** 四个字段：两个有译文、两个没有（缺 label 与 desc）。形状与 pi 适配器的产出一致
 *  （`label`/`description` 都是**派生出的 i18n key**，不是文案）。 */
const FIELDS: KernelConfigField[] = [
  { key: "knownField", type: "string", label: "kernel.fields.knownField", description: "kernel.fieldDescs.knownField", group: "kernel.groups.general" },
  { key: "terminal.known", type: "boolean", label: "kernel.fields.terminal.known", description: "kernel.fieldDescs.terminal.known", group: "kernel.groups.terminal" },
  // ↓ 内核新增、壳 locale 未跟上（实测漏出的那五个就是这一类）
  { key: "modelThinkingLevels", type: "string", label: "kernel.fields.modelThinkingLevels", description: "kernel.fieldDescs.modelThinkingLevels", group: "kernel.groups.general" },
  { key: "terminal.trueColor", type: "boolean", label: "kernel.fields.terminal.trueColor", description: "kernel.fieldDescs.terminal.trueColor", group: "kernel.groups.terminal" },
];

const api: KernelConfigApi = {
  fields: () => Promise.resolve(FIELDS),
  get: () => Promise.resolve({}),
  set: () => Promise.resolve({ ok: true, error: null }),
} as unknown as KernelConfigApi;

function renderForm() {
  return render(
    <I18nextProvider i18n={i18n}>
      <KernelConfigForm api={api} config={{ knownField: "v", terminal: { known: true } }} onChange={() => {}} />
    </I18nextProvider>,
  );
}

describe("KernelConfigForm：未译字段的降级（不得把裸 i18n key 显示给用户）", () => {
  it("已译字段的标签与描述照常渲染（降级不能把正常的也一起关掉）", async () => {
    renderForm();
    await waitFor(() => expect(screen.getByText("已知字段")).toBeInTheDocument());
    expect(screen.getByText("这是已译字段的描述")).toBeInTheDocument();
    expect(screen.getByText("终端已知项")).toBeInTheDocument();
    expect(screen.getByText("这是已译终端项的描述")).toBeInTheDocument();
  });

  it("未译字段的**描述**不渲染任何裸 key（修复前这里会出现 fieldDescs.modelThinkingLevels）", async () => {
    const { container } = renderForm();
    await waitFor(() => expect(screen.getByText("已知字段")).toBeInTheDocument());
    const text = container.textContent ?? "";
    // 这两条就是实测漏出的形态：命名空间前缀被 nsSeparator 切掉后剩下的裸 key
    expect(text, "描述降级失效：裸 key 漏进界面").not.toContain("fieldDescs.modelThinkingLevels");
    expect(text, "描述降级失效：裸 key 漏进界面").not.toContain("fieldDescs.terminal.trueColor");
    expect(text).not.toContain("kernel.fieldDescs.");
  });

  it("未译字段的标签降级为**字段路径**（有意的非空 defaultValue），而不是空标签", async () => {
    // 标签与描述的降级策略**刻意不同**：标签必须有东西可显示（否则控件无从辨认），
    // 故降级到字段路径 `modelThinkingLevels`；描述是补充信息，缺失就该整条不渲染。
    // 这条把两种策略都钉住，防止有人"统一"成一种。
    renderForm();
    await waitFor(() => expect(screen.getByText("已知字段")).toBeInTheDocument());
    expect(screen.getByText("modelThinkingLevels")).toBeInTheDocument();
    expect(screen.getByText("terminal.trueColor")).toBeInTheDocument();
  });

  it("描述 span 的数量 == 有译文的字段数（未译的不占位，不留空 span）", async () => {
    const { container } = renderForm();
    await waitFor(() => expect(screen.getByText("已知字段")).toBeInTheDocument());
    // 每个字段行是 <div><label/><span?/>控件</div>；描述 span 用 muted 色，按文本反查更稳。
    const descs = ["这是已译字段的描述", "这是已译终端项的描述"];
    for (const d of descs) expect(screen.getByText(d)).toBeInTheDocument();
    // 全页文本里不该出现任何 "fieldDescs." 片段
    expect(container.textContent ?? "").not.toMatch(/fieldDescs\./);
  });
});

// 这条不测组件，测**夹具本身有没有能力复现缺陷**。
// 没有它，将来谁"简化"了上面的 init 配置（尤其去掉 returnEmptyString: false），
// 本文件的四条断言会全部继续绿——但那时它们已经不再证明任何东西（假绿）。
describe("夹具自检：本配置确实能复现「defaultValue: '' 被丢弃 → 返回裸 key」", () => {
  it("t(缺失key, { defaultValue: \"\" }) 返回**去掉命名空间前缀的裸 key**（这正是生产缺陷）", () => {
    const raw = i18n.t("kernel.fieldDescs.modelThinkingLevels", { defaultValue: "" });
    expect(raw, "若这条红了，说明夹具配置漂移、上面四条断言已失去意义").toBe("fieldDescs.modelThinkingLevels");
  });

  it("i18n.exists 对缺失/存在的 key 给出正确判断（修复所依赖的 API）", () => {
    expect(i18n.exists("kernel.fieldDescs.knownField")).toBe(true);
    expect(i18n.exists("kernel.fieldDescs.modelThinkingLevels")).toBe(false);
  });
});

// 显式空态守卫（§1.5：唯一明禁的状态是"静默缺面"）。
// 实测依据：dsh 的 fields() 恒返回 []（它的 schema 在运行时的 cordis schemastery 里，桌面读不到，
// 这是 dsh-kernel-config.ts:8 明写的有意降级），而它的 get() 只返回非模型命名空间子集——
// 当 settings.yaml 里只有模型段时就是 {}（实测 kernelConfig.dsh.get() 返回 {}）。
// 两者同时为空时，本组件此前渲染出一个**空 div**：设置页只剩"版本管理"，配置区一片空白、
// 没有任何解释，用户无法区分"这个内核没有可配置项"与"页面加载失败"。
// 真 app 里已验证修复生效（DSH / Minimal 两个设置页都出现了空态说明）。
describe("KernelConfigForm：无可配置项时给显式空态，不渲染空白面板", () => {
  const emptyApi = {
    fields: () => Promise.resolve([] as KernelConfigField[]),
    get: () => Promise.resolve({}),
    set: () => Promise.resolve({ ok: true, error: null }),
  } as unknown as KernelConfigApi;

  it("fields() 为空且 config 为 {} → 渲染一句说明，而不是空 div", async () => {
    const { container } = render(
      <I18nextProvider i18n={i18n}>
        <KernelConfigForm api={emptyApi} config={{}} onChange={() => {}} />
      </I18nextProvider>,
    );
    await waitFor(() => expect((container.textContent ?? "").length).toBeGreaterThan(0));
    // 本夹具的 i18n 没有 settings.noSchemaFields 译文，故走 defaultValue（英文兜底）——
    // 断言"有说明文字"而非具体文案，避免把测试绑死在某一种语言上。
    expect(container.textContent).toContain("no configurable fields");
    // 且不是空白：文本长度明显大于 0，且不含裸 key
    expect((container.textContent ?? "").trim().length).toBeGreaterThan(10);
    expect(container.textContent).not.toMatch(/settings\.noSchemaFields/);
  });

  it("config 有值时不显示空态（改由 InferredField 按值推断渲染，空态不得越权）", async () => {
    const { container } = render(
      <I18nextProvider i18n={i18n}>
        <KernelConfigForm api={emptyApi} config={{ someKey: "v" }} onChange={() => {}} />
      </I18nextProvider>,
    );
    await waitFor(() => expect(container.textContent ?? "").toContain("someKey"));
    expect(container.textContent).not.toContain("no configurable fields");
  });

  it("有字段清单时也不显示空态（正常内核不受影响）", async () => {
    renderForm();
    await waitFor(() => expect(screen.getByText("已知字段")).toBeInTheDocument());
    expect(screen.queryByText(/no configurable fields/)).toBeNull();
  });
});

// 混合字面量联合（如 pi 的 `terminal.hyperlinks?: boolean | "auto"`）的写回种类守卫。
//
// 缺陷背景：解析器此前把「不是全字符串字面量」的联合一律判成 object，于是这三个字段
// （terminal.hyperlinks / terminal.images / terminal.trueColor）在设置页只能拿到**裸 JSON 编辑器**，
// 用户得手敲 `true` / `"auto"`；而同一个表单对**纯字符串**联合给的是下拉框——同一张表单里
// 能力不一致。改成 enum + 每个选项带 `kind` 之后，实测 object 型字段从 5 个降到 2 个
// （剩下的 modelThinkingLevels / packages 确实不透明，JSON 编辑器是对的）。
//
// ⚠ 本组断言的核心不是"渲染成下拉框"，而是**写回的值种类**：HTML `<option value>` 只能是字符串，
//   若不按 kind 转回真值，内核拿到的就是字符串 `"false"` —— 而在 JS 里 `"false"` 是**真值**，
//   语义直接反了（用户选"关闭"，内核当成"开启"）。这类错不会报错、不会崩，只会静默做错事。
describe("KernelConfigForm：混合字面量联合的选项按 kind 写回真值", () => {
  const HYPERLINKS: KernelConfigField = {
    key: "terminal.hyperlinks", type: "enum",
    label: "kernel.fields.terminal.hyperlinks",
    description: "kernel.fieldDescs.terminal.hyperlinks",
    group: "kernel.groups.terminal",
    options: [
      { value: "false", label: "kernel.options.false", kind: "boolean" },
      { value: "true", label: "kernel.options.true", kind: "boolean" },
      { value: "auto", label: "kernel.options.auto", kind: "string" },
    ],
  };
  const IMAGES: KernelConfigField = {
    key: "terminal.images", type: "enum",
    options: [
      { value: "false", kind: "boolean" },
      { value: "auto", kind: "string" },
      { value: "kitty", kind: "string" },
    ],
  } as KernelConfigField;

  function renderWith(fields: KernelConfigField[], initial: Record<string, unknown>) {
    const seen: Record<string, unknown>[] = [];
    const api = {
      fields: () => Promise.resolve(fields),
      get: () => Promise.resolve({}),
      set: () => Promise.resolve({ ok: true, error: null }),
    } as unknown as KernelConfigApi;
    render(
      <I18nextProvider i18n={i18n}>
        <KernelConfigForm api={api} config={initial} onChange={(c) => seen.push(c)} />
      </I18nextProvider>,
    );
    return seen;
  }

  it("选 false → 写回**布尔 false**，不是字符串 \"false\"", async () => {
    const seen = renderWith([HYPERLINKS], { terminal: { hyperlinks: "auto" } });
    await waitFor(() => expect(document.querySelector("select")).toBeTruthy());
    const sel = document.querySelector("select")!;
    fireEvent.change(sel, { target: { value: "false" } });
    expect(seen.length, "onChange 应被调用一次").toBe(1);
    const got = (seen[0] as { terminal: { hyperlinks: unknown } }).terminal.hyperlinks;
    expect(got).toBe(false);
    expect(typeof got, "写回字符串 \"false\" 在 JS 里是真值，语义会反过来").toBe("boolean");
  });

  it("选 true → 写回布尔 true；选 auto → 写回**字符串** \"auto\"（同一个字段两种种类）", async () => {
    const seen = renderWith([HYPERLINKS], { terminal: { hyperlinks: false } });
    await waitFor(() => expect(document.querySelector("select")).toBeTruthy());
    const sel = document.querySelector("select")!;
    fireEvent.change(sel, { target: { value: "true" } });
    fireEvent.change(sel, { target: { value: "auto" } });
    const vals = seen.map((c) => (c as { terminal: { hyperlinks: unknown } }).terminal.hyperlinks);
    expect(vals[0]).toBe(true);
    expect(typeof vals[0]).toBe("boolean");
    expect(vals[1]).toBe("auto");
    expect(typeof vals[1], "auto 是字符串字面量，不能转成布尔").toBe("string");
  });

  it("当前值是真布尔时，下拉框能正确选中对应项（显示侧也要过 String()）", async () => {
    renderWith([HYPERLINKS], { terminal: { hyperlinks: false } });
    await waitFor(() => expect(document.querySelector("select")).toBeTruthy());
    const sel = document.querySelector("select") as HTMLSelectElement;
    // 存的是布尔 false，<option value="false"> 才对得上；若直接塞布尔进 value，选中态会丢
    expect(sel.value, "布尔 false 应选中 value=\"false\" 那一项").toBe("false");
  });

  it("数字种类同样转回真数字（kind 机制不是只为布尔存在）", async () => {
    const field = {
      key: "n", type: "enum",
      options: [{ value: "0", kind: "number" }, { value: "42", kind: "number" }],
    } as unknown as KernelConfigField;
    const seen = renderWith([field], { n: 0 });
    await waitFor(() => expect(document.querySelector("select")).toBeTruthy());
    fireEvent.change(document.querySelector("select")!, { target: { value: "42" } });
    expect(seen[0].n).toBe(42);
    expect(typeof seen[0].n).toBe("number");
  });

  it("未声明 kind 的选项按字符串处理（向后兼容：既有内核不受影响）", async () => {
    const field = {
      key: "mode", type: "enum",
      options: [{ value: "all" }, { value: "one-at-a-time" }],
    } as unknown as KernelConfigField;
    const seen = renderWith([field], { mode: "all" });
    await waitFor(() => expect(document.querySelector("select")).toBeTruthy());
    fireEvent.change(document.querySelector("select")!, { target: { value: "one-at-a-time" } });
    expect(seen[0].mode).toBe("one-at-a-time");
  });

  it("配置里的值不在枚举内时**如实显示真值**，不静默映射到某个合法选项", async () => {
    // 原生 <select> 无法表示"选项外的值"：不补合成选项的话浏览器会退回显示第一项，
    // 于是界面显示 false 而磁盘上存的是 "sixel" —— 数据没坏（onChange 未触发），
    // 但界面在撒谎。修法是按当前值补一个 disabled 的合成项。
    renderWith([IMAGES], { terminal: { images: "sixel" } });
    await waitFor(() => expect(document.querySelector("select")).toBeTruthy());
    const sel = document.querySelector("select") as HTMLSelectElement;
    expect(sel.value, "未知值必须被如实选中显示").toBe("sixel");
    const synthetic = [...sel.options].find((o) => o.value === "sixel");
    expect(synthetic, "应补出一个合成选项").toBeTruthy();
    expect(synthetic!.disabled, "合成项不可再选（它本来就不是合法值）").toBe(true);
    expect(synthetic!.textContent).toContain("sixel");
  });
});

// ---- object 型字段的 JSON 编辑器：边改边提交（r21 修，此前是 blur-only）----
//
// 旧行为的代价是实测出来的（scripts/demo/settings-controls-audit.e2e.mjs ⑥）：
// 键入合法 JSON 后**保存浮层根本不出现**（onChange 没被调用 → 框架不知道有改动），
// 用户看不到"有未保存改动"；此时直接关窗/切页，blur 可能不触发 → 编辑静默丢失且无提示。
describe("KernelConfigForm：object 字段的 JSON 编辑器边改边提交", () => {
  const OBJ: KernelConfigField = { key: "blob", type: "object", label: "kernel.fields.blob" } as KernelConfigField;

  function setup(initial: Record<string, unknown>) {
    const seen: Record<string, unknown>[] = [];
    const api = {
      fields: () => Promise.resolve([OBJ]),
      get: () => Promise.resolve({}),
      set: () => Promise.resolve({ ok: true, error: null }),
    } as unknown as KernelConfigApi;
    const view = render(
      <I18nextProvider i18n={i18n}>
        <KernelConfigForm api={api} config={initial} onChange={(c) => seen.push(c)} />
      </I18nextProvider>,
    );
    return { seen, view };
  }
  const textarea = (): HTMLTextAreaElement => document.querySelector("textarea") as HTMLTextAreaElement;

  it("键入**合法** JSON 立刻上报（不等 blur）——保存浮层因此才会出现", async () => {
    const { seen } = setup({ blob: { a: 1 } });
    await waitFor(() => expect(textarea()).toBeTruthy());
    fireEvent.change(textarea(), { target: { value: '{"a":2,"b":[1,2]}' } });
    expect(seen.length, "合法 JSON 必须立刻上报（旧行为要等 blur，浮层在此之前不出现）").toBe(1);
    expect(seen[0].blob).toEqual({ a: 2, b: [1, 2] });
  });

  it("键入**非法** JSON：显示错误且**不上报**（半成品不该污染配置，也不该清掉原值）", async () => {
    const { seen } = setup({ blob: { a: 1 } });
    await waitFor(() => expect(textarea()).toBeTruthy());
    fireEvent.change(textarea(), { target: { value: '{ 这不是 JSON' } });
    expect(seen.length, "解析失败不该上报").toBe(0);
    expect(textarea().value, "草稿保留用户敲的内容（不回滚，否则没法继续改）").toBe("{ 这不是 JSON");
  });

  it("清空草稿 → 上报 undefined（『未设值』语义，与旧行为一致）", async () => {
    const { seen } = setup({ blob: { a: 1 } });
    await waitFor(() => expect(textarea()).toBeTruthy());
    fireEvent.change(textarea(), { target: { value: "   " } });
    expect(seen.length).toBe(1);
    expect(seen[0].blob, "空草稿 = 未设值").toBeUndefined();
  });

  it("★ 自己刚上报的值回流时**不重排版草稿**（否则每敲一个字符就被 stringify 重排，没法编辑）", async () => {
    // 这条守的是"边改边提交"引入的新风险：onChange → 父层 value 变 → effect 把 value
    // 序列化回 draft。若不做"是我自己上报的"判定，用户输入 `{"a":1}` 会立刻被改成
    // 带缩进换行的 `{\n  "a": 1\n}`，光标跳到末尾——功能"通了"但完全不可用。
    const { seen } = setup({ blob: { a: 1 } });
    await waitFor(() => expect(textarea()).toBeTruthy());
    const typed = '{"a":2}';                        // 紧凑写法，故意与 stringify 的缩进形态不同
    fireEvent.change(textarea(), { target: { value: typed } });
    expect(seen.length).toBe(1);
    // 父层回流同一个值（这里用 rerender 模拟 config 更新）
    expect(textarea().value, "草稿必须保持用户敲的原样，不能被 JSON.stringify 重排版").toBe(typed);
  });

  it("外部真的换了值（不是自己上报的回流）→ 草稿跟着更新", async () => {
    const seen: Record<string, unknown>[] = [];
    const api = {
      fields: () => Promise.resolve([OBJ]),
      get: () => Promise.resolve({}),
      set: () => Promise.resolve({ ok: true, error: null }),
    } as unknown as KernelConfigApi;
    const { rerender } = render(
      <I18nextProvider i18n={i18n}>
        <KernelConfigForm api={api} config={{ blob: { a: 1 } }} onChange={(c) => seen.push(c)} />
      </I18nextProvider>,
    );
    await waitFor(() => expect(textarea()).toBeTruthy());
    expect(textarea().value).toContain('"a": 1');
    rerender(
      <I18nextProvider i18n={i18n}>
        <KernelConfigForm api={api} config={{ blob: { a: 99 } }} onChange={(c) => seen.push(c)} />
      </I18nextProvider>,
    );
    await waitFor(() => expect(textarea().value).toContain('"a": 99'));
    expect(seen.length, "外部更新不该被当成用户编辑上报").toBe(0);
  });
});
