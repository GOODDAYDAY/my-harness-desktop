// 测试拉起 app 的环境基线 —— **默认静默**(§5.6 测试静默纪律)。
//
// 背景(根因):应用原本开窗后无条件 `win.show()`,macOS 上 show() 会激活应用 → 用户正在用的
// 窗口失焦、鼠标被夺走,界面上凭空多出一个窗口。跑一次 e2e 就打扰用户一次。
// 应用侧已按 `MHD_WINDOW` 分岔(electron.ts / window-visibility.ts),本文件负责让**测试侧默认 hidden**。
//
// 为什么收成一个 helper,而不是每个脚本自己写一行:`launchApp` / `verify-e2e.mjs` /
// `pixel-check.mjs` / `verify-model-probe.mjs` 四个入口各写一份,漏一个就回到"跑测试,抢用户窗口"。
// 静态守卫 `scripts/quiet-launch-audit.mjs` 钉住"凡 spawn electron 的脚本都必须过这里"。
//
// 想看着窗口跑(人工观察 / 录 GIF 要肉眼看流程):
//   MHD_WINDOW=shown node scripts/demo/<某剧本>.e2e.mjs
export function quietEnv(env = process.env) {
  return { ...env, MHD_WINDOW: env.MHD_WINDOW || "hidden" };
}
