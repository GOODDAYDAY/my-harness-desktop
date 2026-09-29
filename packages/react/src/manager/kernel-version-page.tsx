import { pickDirectory } from "../widgets/pick-directory";
// packages/react 内核管理共享 base —— 「内核版本管理」页骨架（kernel-design-spec.md §12.4）。
//
// pi-manager 的 KernelSection + CustomCliSection 与 dsh-manager 的 DshKernelPage +
// DshCustomCliSection 曾是逐行 copy，本组件把「版本信息 + 安装/切换 + 自定义目录」
// 三个区块收敛成一份，pi/dsh 只填 spec（api + i18nPrefix）。
// 基类是机制（内核无关骨架）：不 import 任何内核、不含 `if (kernel === "pi")` 分支，
// 差异经 props 参数化。放 packages/react 而非 core/（core 零 React 依赖）。
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import semver from "semver";
import { Button } from "../widgets/button";
import { Select } from "../widgets/select";
import { usePluginContext } from "../plugin-context";
import type { KernelStatusView, KernelVersionApi } from "@my-harness-desktop/shared";

/** 内核安装基础能力(pi/dsh 的 ctx.kernels[KernelId] 都满足此形状)。契约单源在 domain 的
 *  KernelVersionApi,此处 re-export 保持 KernelVersionPage 的 prop 名不变(§1.3)。 */
export type KernelInstallApi = KernelVersionApi;

export interface KernelVersionPageProps {
  api: KernelInstallApi;
  /** i18n key 前缀（如 "kernel" / "dsh"），base 用统一后缀（title/desc/installedVersion/…）。 */
  i18nPrefix: string;
}

export function KernelVersionPage({ api, i18nPrefix }: KernelVersionPageProps): React.ReactNode {
  const { t } = useTranslation();
  const k = (suffix: string, vars?: Record<string, unknown>): string => t(`${i18nPrefix}.${suffix}`, vars);
  const [status, setStatus] = useState<KernelStatusView | null>(null);
  /** 该内核的版本面能力（数据驱动显式降级；缺省 null = 还没问到，按"不支持"渲染以免闪出用不了的控件）。 */
  const [caps, setCaps] = useState<{ install: boolean; customDir: boolean } | null>(null);
  const [registry, setRegistry] = useState<{ versions: string[]; latest: string | null } | null>(null);
  const [regFailed, setRegFailed] = useState(false);
  const [checking, setChecking] = useState(false);
  const [targetVersion, setTargetVersion] = useState("");
  const [installing, setInstalling] = useState(false);
  const [installOutput, setInstallOutput] = useState<string[]>([]);
  const [installResult, setInstallResult] = useState<{ ok: boolean; error: string | null } | null>(null);
  const installDoneRef = useRef(false);

  useEffect(() => {
    setRegFailed(false);
    void api.capabilities().then(setCaps);
    void api.status().then(setStatus);
    void api.listVersions().then((r) => {
      setRegistry(r);
      setTargetVersion((prev) => prev || r.latest || "");
    }).catch(() => setRegFailed(true));
  }, [api]);

  const refresh = async (): Promise<void> => {
    setChecking(true);
    setRegFailed(false);
    try {
      setRegistry(await api.listVersions(true));
    } catch {
      setRegFailed(true);
    } finally {
      setChecking(false);
    }
  };

  const install = async (): Promise<void> => {
    if (!targetVersion) return;
    setInstalling(true);
    setInstallOutput([]);
    setInstallResult(null);
    installDoneRef.current = false;
    // ⚠ r211：静默失败的**第四种形态**（r210 识别的）——结果对象协议 + done 回调
    //   只覆盖"安装失败"与"安装完成"，**覆盖不到"调用没完成"**：
    //   api.install(...) 在传输层 reject 时（ws-transport 的 failAll 在鉴权被拒/连接断开时
    //   一律 reject，r177/r178）await 直接抛出 ⇒ done 回调不会被调、`if (!r.ok)` 也走不到
    //   ⇒ setInstalling(true) 永久留着，**安装按钮永久卡在 installing 态**（用户只能重启）。
    //   所以用 try/catch/finally：finally 保证旗标一定解除（幂等，done 回调已解除也无害），
    //   catch 把 reject 也变成可见的失败结果。
    try {
      const r = await api.install(
        targetVersion,
        (line) => setInstallOutput((prev) => [...prev, line]),
        (done) => {
          installDoneRef.current = true;
          setInstalling(false);
          setInstallResult(done);
          if (done.ok) {
            void api.status().then(setStatus);
            void api.listVersions(true).then(setRegistry).catch(() => setRegFailed(true));
          }
        },
      );
      if (!r.ok && !installDoneRef.current) setInstallResult(r);
    } catch (err) {
      if (!installDoneRef.current) {
        setInstallResult({ ok: false, error: (err as Error)?.message ?? String(err) });
      }
    } finally {
      setInstalling(false);
    }
  };

  const current = status?.currentVersion ?? null;
  const latest = registry?.latest ?? null;
  const cmp = current && targetVersion && semver.valid(current) && semver.valid(targetVersion)
    ? semver.compare(current, targetVersion)
    : null;
  const isDowngrade = cmp !== null && cmp > 0;
  const isUpgrade = cmp !== null && cmp < 0;
  const isSame = cmp !== null && cmp === 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-lg)" }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "var(--spacing-sm)" }}>
        <div>
          <h2 style={{ margin: 0, fontSize: "var(--font-size-lg)", fontWeight: 600 }}>{k("title")}</h2>
          <p style={{ margin: "var(--spacing-xs) 0 0", color: "var(--color-muted)", fontSize: "var(--font-size-sm)" }}>{k("desc")}</p>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1.2fr", gap: "var(--spacing-xl)", alignItems: "start" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-sm)" }}>
          <InfoRow label={k("installedVersion")} value={current ?? (status?.available ? t("common.unknown") : t("common.notInstalled"))} />
          {/* "最新版本 + 检查更新"只在支持安装的内核上有意义：内置内核没有版本源，
              画出这一行只会让人以为"没查到"（其实是"没有这回事"）。 */}
          {caps?.install === true && (
          <div style={{ display: "flex", gap: "var(--spacing-md)", alignItems: "center", fontSize: "var(--font-size-sm)" }}>
            <span style={{ color: "var(--color-muted)", minWidth: "80px" }}>{k("latestVersion")}</span>
            <span style={{ color: (latest && current && current !== latest) ? "var(--color-accent-warning)" : "var(--color-fg)", fontFamily: "var(--font-family-mono)" }}>
              {regFailed ? k("fetchFailed") : (latest ?? t("common.loading"))}
            </span>
            <Button variant="secondary" onClick={() => void refresh()} disabled={checking} style={{ padding: "2px var(--spacing-sm)" }}>
              {checking ? t("common.checking") : k("checkUpdate")}
            </Button>
          </div>
          )}
          <InfoRow
            label={k("status")}
            value={
              // 不支持安装的内核：状态就是"内置"（该内核自己的文案），不落到 common.unknown——
              // "未知"读起来像"查不到"，而真相是"没有版本这回事"。
              caps?.install === false
                ? k("upToDate")
                : !status?.available
                  ? `${t("common.notInstalled")}${status?.error ? `:${status.error}` : ""}`
                  : latest && current === latest
                    ? k("upToDate")
                    : latest && current && current !== latest
                      ? k("newAvailable")
                      : t("common.unknown")
            }
          />
          <InfoRow
            label={k("effectiveSource")}
            highlight={!!status?.error}
            value={
              status?.source === "custom"
                ? status.error
                  ? `${k("customCli.sourceCustom")} · ${status.error}`
                  : `${k("customCli.sourceCustom")} ${status.currentVersion ?? t("common.unknown")}`
                : k("customCli.sourceInstalled")
            }
          />
        </div>

        {caps?.install !== true ? (
          // 只在内核**明确支持**安装时才画安装区（caps 未到 = 按不支持，先不画）。
          // 内置内核（随壳分发、不装不升不降）：**不画**用不了的安装控件。
          // 这是 §7.6 三分法的第三档「显式降级」——隐藏入口，而不是画一个点了没用的按钮。
          // 判据是**数据**（capabilities.install），不是内核身份分支：加第四个内核只填它自己的旗标。
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-sm)", borderLeft: "1px solid var(--color-border)", paddingLeft: "var(--spacing-xl)" }}>
            <div>
              {/* 一句话说清"为什么没有安装区"，而不是留一片空白让人猜。文案由该内核自己的
                  语言包给（内容归插件）；只有不支持安装的内核会渲染到它。 */}
              <p style={{ margin: 0, color: "var(--color-muted)", fontSize: "var(--font-size-sm)" }}>{k("noInstallHint")}</p>
            </div>
          </div>
        ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-sm)", borderLeft: "1px solid var(--color-border)", paddingLeft: "var(--spacing-xl)" }}>
          <div>
            <h3 style={{ margin: 0, fontSize: "var(--font-size-base)", fontWeight: 600 }}>{k("installSwitch")}</h3>
            <p style={{ margin: "var(--spacing-xs) 0 0", color: "var(--color-muted)", fontSize: "var(--font-size-sm)" }}>
              {isUpgrade && <span style={{ color: "var(--color-accent-success)" }}> {k("willUpgrade", { current, target: targetVersion })}</span>}
              {isDowngrade && <span style={{ color: "var(--color-accent-warning)" }}> {k("willDowngrade", { current, target: targetVersion })}</span>}
              {isSame && <span style={{ color: "var(--color-muted)" }}> {k("currentVersion")}</span>}
              {!current && targetVersion && <span style={{ color: "var(--color-accent-success)" }}> {k("willInstall", { target: targetVersion })}</span>}
            </p>
            {status?.source === "custom" && (
              <p style={{ margin: "var(--spacing-xs) 0 0", color: "var(--color-muted)", fontSize: "var(--font-size-sm)" }}>{k("customCli.overrideHint")}</p>
            )}
          </div>
          <div style={{ display: "flex", gap: "var(--spacing-sm)", alignItems: "center" }}>
            <Select mono value={targetVersion} onChange={setTargetVersion} disabled={installing || !registry} ariaLabel={k("installSwitch")}>
              {registry?.versions.slice().reverse().map((v) => (
                <option key={v} value={v}>{v}{v === latest ? ` (${t("common.latest")})` : ""}{v === current ? ` (${t("common.installed")})` : ""}</option>
              ))}
            </Select>
            <Button variant="primary" onClick={() => void install()} disabled={installing || !targetVersion || isSame}>
              {installing ? t("common.installing") : isSame ? k("currentVersion") : isDowngrade ? k("downgradeThis") : isUpgrade ? k("upgradeThis") : k("installThis")}
            </Button>
          </div>
          {(installing || installOutput.length > 0 || installResult) && (
            <div>
              <div style={{ fontSize: "var(--font-size-sm)", color: "var(--color-muted)", marginBottom: "var(--spacing-xs)" }}>{k("installOutput")}</div>
              <pre style={{
                background: "var(--color-surface)", border: "1px solid var(--color-border)",
                borderRadius: "var(--radius-md)", padding: "var(--spacing-sm) var(--spacing-md)",
                fontFamily: "var(--font-family-mono)", fontSize: "var(--font-size-sm)",
                color: "var(--color-fg)", maxHeight: "240px", overflowY: "auto", margin: 0, whiteSpace: "pre-wrap",
              }}>
                {installOutput.join("\n")}
                {installing && "…"}
                {installResult && (
                  <div style={{ marginTop: "var(--spacing-xs)", color: installResult.ok ? "var(--color-accent-success)" : "var(--color-accent-error)" }}>
                    {installResult.ok ? k("installDone", { target: targetVersion }) : k("installFailed", { error: installResult.error })}
                  </div>
                )}
              </pre>
            </div>
          )}
        </div>
        )}
      </div>

      {caps?.customDir === true && (
        <CustomCliSection api={api} i18nPrefix={i18nPrefix} status={status} onStatus={setStatus} />
      )}
    </div>
  );
}

function CustomCliSection({ api, i18nPrefix, status, onStatus }: {
  api: KernelInstallApi;
  i18nPrefix: string;
  status: KernelStatusView | null;
  onStatus: (s: KernelStatusView) => void;
}): React.ReactNode {
  const ctx = usePluginContext();
  const { t } = useTranslation();
  const k = (suffix: string, vars?: Record<string, unknown>): string => t(`${i18nPrefix}.customCli.${suffix}`, vars);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  const appliedDir = status?.customCliDir ?? "";
  useEffect(() => { setInput(appliedDir); }, [appliedDir]);

  const changed = input.trim() !== appliedDir;

  const apply = async (dir: string): Promise<void> => {
    setBusy(true);
    setFeedback(null);
    try {
      const r = await api.setCustomCliDir(dir);
      if (!r.ok) {
        setFeedback({ ok: false, text: r.error ?? k("failed") });
        return;
      }
      if (r.status) onStatus(r.status);
      const version = r.status?.currentVersion ?? t("common.unknown");
      setFeedback({
        ok: true,
        text: !dir
          ? k("cleared")
          : (r.pendingCount ?? 0) > 0
            ? k("appliedWithPending", { version, count: r.pendingCount })
            : k("applied", { version }),
      });
    } finally {
      setBusy(false);
    }
  };

  const browse = async (): Promise<void> => {
    const dir = await pickDirectory(ctx);   // r137：统一原语（同包内相对导入）
    if (dir) setInput(dir);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-sm)", borderTop: "1px solid var(--color-border)", paddingTop: "var(--spacing-lg)" }}>
      <div>
        <h3 style={{ margin: 0, fontSize: "var(--font-size-base)", fontWeight: 600 }}>{k("title")}</h3>
        <p style={{ margin: "var(--spacing-xs) 0 0", color: "var(--color-muted)", fontSize: "var(--font-size-sm)" }}>{k("desc")}</p>
      </div>
      <div style={{ display: "flex", gap: "var(--spacing-sm)", alignItems: "center" }}>
        <input
          type="text"
          // 稳定锚点（§17.3）：自定义内核目录是**内核插件自定 prefs 键**的写入入口，
          // 它的读写路径在 r32 改成了动态键 API（不再枚举进 application 层的 Prefs 类型），
          // 需要 e2e 能确定性定位来验「设置 → 落盘 → 读回 → 清除」整条链。
          data-kernel-custom-dir=""
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={k("placeholder")}
          style={{
            flex: 1, padding: "var(--spacing-xs) var(--spacing-sm)",
            border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)",
            background: "var(--color-surface)", color: "var(--color-fg)",
            fontFamily: "var(--font-family-mono)", fontSize: "var(--font-size-sm)", boxSizing: "border-box",
          }}
        />
        <Button variant="secondary" data-kernel-custom-dir-browse="" onClick={() => void browse()} disabled={busy}>{k("browse")}</Button>
        <Button variant="primary" data-kernel-custom-dir-apply="" onClick={() => void apply(input.trim())} disabled={busy || !changed}>{k("apply")}</Button>
        <Button variant="secondary" data-kernel-custom-dir-clear="" onClick={() => void apply("")} disabled={busy || !appliedDir}>{k("clear")}</Button>
      </div>
      {feedback && (
        <div style={{ fontSize: "var(--font-size-sm)", color: feedback.ok ? "var(--color-accent-success)" : "var(--color-accent-error)" }}>
          {feedback.text}
        </div>
      )}
    </div>
  );
}

function InfoRow({ label, value, highlight }: { label: string; value: string; highlight?: boolean }): React.ReactNode {
  return (
    <div style={{ display: "flex", gap: "var(--spacing-md)", alignItems: "center", fontSize: "var(--font-size-sm)" }}>
      <span style={{ color: "var(--color-muted)", minWidth: "80px" }}>{label}</span>
      <span style={{ color: highlight ? "var(--color-accent-warning)" : "var(--color-fg)", fontFamily: "var(--font-family-mono)" }}>{value}</span>
    </div>
  );
}
