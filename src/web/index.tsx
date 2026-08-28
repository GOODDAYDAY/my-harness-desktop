// renderer HTML 入口 —— 登录门(§8.2/§8.3)+ 应用引导的两段式。
//
// 为什么两段:应用主体(./app-main)的静态依赖在模块级读 window.kernel(titlebar 的
// platform 等),而 window.kernel 由 ./bootstrap 构建——远程浏览器未鉴权时根本不该建
// WS/kernel。故入口先查 /auth-state:
//   required=false(loopback 本机 / 已持 cookie / ?token= 有效)→ 引导应用;
//   required=true → 渲染登录表单,登录成功整页重载再走本流程。
// 密码不进 URL(§8.1):凭证只经表单 + httpOnly cookie / hello token 传递。
import { ensureAuthenticated } from "./login-gate";

const rootEl = document.getElementById("root");
if (rootEl) {
  void (async () => {
    const ok = await ensureAuthenticated(rootEl);
    if (!ok) return; // 登录表单已接管页面(或错误态)
    // 顺序敏感:先建 window.kernel,再加载读它的应用主体。
    await import("./bootstrap");
    await import("./app-main");
  })();
}
