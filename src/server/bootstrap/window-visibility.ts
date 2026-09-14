// 窗口可见性策略(纯逻辑,零依赖)—— 自动化/测试拉起 app 时**不抢用户焦点**。
//
// 为什么要有这条策略(根因):
//   electron.ts 原本无条件 `win.on("ready-to-show", () => win.show())`。macOS 上 `show()`
//   会把应用激活 → 用户正在打字的窗口失焦、鼠标被夺走,屏幕上凭空多出一个窗口。
//   后果是"我的每一次验证都在打断用户的工作",而 e2e 并**不需要**窗口可见:
//   它要的是 CDP(JS 求值 / Input.dispatchKeyEvent / Page.captureScreenshot),
//   这些都不依赖窗口被 show。
//   所以把"要不要 show"从硬编码改成策略:MHD_WINDOW=hidden 时永不 show。
//
// 纯函数(§4.5 判据):不读 process.env、不 import electron —— env 由调用方注入,便于单测。
// 守卫测试:window-visibility.test.ts。

/** `MHD_WINDOW` 的合法取值。缺省(未设)等价于 "shown"——正常开发/生产行为不变。 */
export type WindowVisibility = "shown" | "hidden";

export interface WindowVisibilityPolicy {
  /** ready-to-show 时是否 `win.show()`。false = 窗口全程不出现(测试静默)。 */
  show: boolean;
  /** 窗口能否获得焦点。静默时 false:即使将来被 show,也不夺键盘焦点。 */
  focusable: boolean;
  /** 是否跳过任务栏/Dock 窗口列表。静默时 true(不露头)。 */
  skipTaskbar: boolean;
  /**
   * Chromium 后台节流。静默时 **false**:窗口不可见时定时器/rAF 会被降频到 ~1Hz,
   * 长回合 e2e 会因此假失败(等不到该收敛的 DOM),不是产品 bug 却被记成红。
   */
  backgroundThrottling: boolean;
  /** 是否允许 OS 级通知横幅。静默时 false:系统级弹窗同样是"抢占式打扰"。 */
  nativeAlerts: boolean;
  /** 是否设置 Dock 图标(macOS)。静默时不设,并 hide dock —— 避免应用参与激活。 */
  dockIcon: boolean;
}

const SHOWN: WindowVisibilityPolicy = {
  show: true,
  focusable: true,
  skipTaskbar: false,
  backgroundThrottling: true,
  nativeAlerts: true,
  dockIcon: true,
};

const HIDDEN: WindowVisibilityPolicy = {
  show: false,
  focusable: false,
  skipTaskbar: true,
  backgroundThrottling: false,
  nativeAlerts: false,
  dockIcon: false,
};

/**
 * 由环境变量算出窗口可见性策略。
 *
 * 非法值**响亮抛错**而不是回落到 shown:写错一个字母(`MHD_WINDOW=hiden`)如果静默按 shown 走,
 * 结果就是"以为静默了,其实又把用户的窗口顶掉了"——这正是最坏形态(§1.5 不允许静默缺面:
 * 宁可在启动这一步失败,也不要假装守住了纪律)。
 */
export function windowVisibilityPolicy(env: Record<string, string | undefined>): WindowVisibilityPolicy {
  const raw = (env["MHD_WINDOW"] ?? "").trim();
  if (raw === "" || raw === "shown") return SHOWN;
  if (raw === "hidden") return HIDDEN;
  throw new Error(`MHD_WINDOW 只接受 "shown" | "hidden"(收到 "${raw}")`);
}
