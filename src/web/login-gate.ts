// 登录门(web-service §8.2/§8.3)——远程浏览器未持凭证时,先渲染登录表单再引导应用。
// 引导期基础设施:纯 DOM 实现,零依赖(此时 window.kernel 尚未构建,React 树未起)。
// loopback 本机直连经 /auth-state 判 required=false,直接放行,不经过本表单。

/** 查询本连接的鉴权态势。失败抛错(由调用方渲染错误态)。 */
async function fetchAuthState(): Promise<{ required: boolean }> {
  const res = await fetch("/auth-state", { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`auth-state ${res.status}`);
  return (await res.json()) as { required: boolean };
}

/** 登录表单文案(引导期无 i18n 框架,中英对照写死——与 /login 服务端错误文案同属基础设施层)。 */
const TEXT = {
  title: "My Harness Desktop",
  subtitle: "局域网访问需要密码 · LAN access requires the password",
  placeholder: "输入访问密码 / Enter password",
  submit: "登 录",
  submitting: "登录中…",
  wrong: "密码错误",
  locked: (sec: number) => `尝试过多,请 ${sec} 秒后再试`,
};

/** 渲染登录表单并接管 #root。返回的 Promise 永不 resolve(登录成功后整页重载)。 */
function renderLoginForm(root: HTMLElement): void {
  root.innerHTML = `
    <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;
      background:#101014;color:#e6e6ea;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',sans-serif;">
      <form id="mhd-login" style="width:340px;padding:32px 28px;border-radius:12px;background:#1a1a21;
        border:1px solid #2c2c35;box-shadow:0 8px 32px rgba(0,0,0,.4);display:flex;flex-direction:column;gap:16px;">
        <div style="font-size:17px;font-weight:600;text-align:center;">${TEXT.title}</div>
        <div style="font-size:12px;color:#8b8b96;text-align:center;line-height:1.5;">${TEXT.subtitle}</div>
        <input id="mhd-login-pwd" type="password" placeholder="${TEXT.placeholder}" autocomplete="current-password"
          style="padding:10px 12px;border-radius:8px;border:1px solid #2c2c35;background:#101014;color:#e6e6ea;
            font-size:14px;outline:none;" />
        <button id="mhd-login-btn" type="submit" style="padding:10px 12px;border-radius:8px;border:none;
          background:#3d6bff;color:#fff;font-size:14px;cursor:pointer;">${TEXT.submit}</button>
        <div id="mhd-login-err" role="alert" style="min-height:18px;font-size:12px;color:#ff6b6b;text-align:center;"></div>
      </form>
    </div>`;

  const form = root.querySelector<HTMLFormElement>("#mhd-login")!;
  const pwd = root.querySelector<HTMLInputElement>("#mhd-login-pwd")!;
  const btn = root.querySelector<HTMLButtonElement>("#mhd-login-btn")!;
  const err = root.querySelector<HTMLDivElement>("#mhd-login-err")!;
  pwd.focus();

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (btn.disabled) return;
    btn.disabled = true;
    btn.textContent = TEXT.submitting;
    err.textContent = "";
    try {
      const res = await fetch("/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: pwd.value }),
      });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; retryAfterSec?: number } | null;
      if (res.ok && body?.ok) {
        // cookie 已种;整页重载走正常引导(去掉 query 里的临时参数)
        location.replace(location.pathname);
        return;
      }
      if (res.status === 429) {
        err.textContent = body?.retryAfterSec ? TEXT.locked(body.retryAfterSec) : (body?.error ?? "尝试过多");
      } else {
        err.textContent = body?.error ?? TEXT.wrong;
      }
    } catch {
      err.textContent = "网络错误,请重试";
    }
    btn.disabled = false;
    btn.textContent = TEXT.submit;
    pwd.select();
  });
}

/** 引导闸门:已鉴权(或未开启远程鉴权)→ true,继续引导;需要登录 → 渲染表单并返回 false。 */
export async function ensureAuthenticated(root: HTMLElement): Promise<boolean> {
  try {
    const state = await fetchAuthState();
    if (!state.required) return true;
  } catch (e) {
    root.innerHTML = `<div style="padding:32px;font-family:sans-serif;color:#c00;">auth-state 不可用: ${String(e)}</div>`;
    return false;
  }
  renderLoginForm(root);
  return false;
}
