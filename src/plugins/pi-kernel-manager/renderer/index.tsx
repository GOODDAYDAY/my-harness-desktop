// pi-kernel-manager 插件 renderer —— pi 内核版本管理设置页。
//
// 用户决策:只维护 ~/.pi-desktop/pi 这一份 pi,不掺和 PATH 里的 pi、不走 pi update。
// 桌面端经 npm install 把指定版本装到 ~/.pi-desktop/pi(覆盖式):
// - 装最新 = 更新,装旧版 = 降级,都是同一个"安装/切换版本"动作
// - 当前版本读 ~/.pi-desktop/pi 里的 package.json(不 spawn PATH 的 pi)
// - registry fetch npm 拿版本清单(只展示,不替用户决策)
//
// 纯 renderer 插件(无 main),贡献 settings 槽一项(component=KernelSettings)。
// 经 @pi-desktop/react 受控 API(守薄壳:不直连 shell)。
import { useEffect, useState } from "react";
import { registerSettingsComponent, usePiApi } from "@pi-desktop/react";

registerSettingsComponent("KernelSettings", KernelSettings);

interface KernelStatus {
  currentVersion: string | null;
  available: boolean;
  error: string | null;
}

export function KernelSettings(): React.ReactNode {
  const pi = usePiApi();
  const [status, setStatus] = useState<KernelStatus | null>(null);
  const [registry, setRegistry] = useState<{ versions: string[]; latest: string | null } | null>(null);
  const [checking, setChecking] = useState(false);
  // 安装/切换版本(覆盖式:装新=更新、装旧=降级,都是 npm install 到 ~/.pi-desktop/pi)
  const [targetVersion, setTargetVersion] = useState<string>("");
  const [installing, setInstalling] = useState(false);
  const [installOutput, setInstallOutput] = useState<string[]>([]);
  const [installResult, setInstallResult] = useState<{ ok: boolean; error: string | null } | null>(null);

  // 启动:拉当前已装版本 + registry 版本清单
  useEffect(() => {
    void pi.kernel.status().then(setStatus);
    void pi.kernel.listVersions().then((r) => {
      setRegistry(r);
      // 默认目标版本:选最新(若已装最新则按钮禁用,选别的版本即可降级)
      setTargetVersion(r.latest ?? "");
    });
  }, [pi]);

  const refresh = async (): Promise<void> => {
    setChecking(true);
    try {
      const r = await pi.kernel.listVersions(true);
      setRegistry(r);
    } finally {
      setChecking(false);
    }
  };

  const install = async (): Promise<void> => {
    if (!targetVersion) return;
    setInstalling(true);
    setInstallOutput([]);
    setInstallResult(null);
    const r = await pi.kernel.install(
      targetVersion,
      (line) => setInstallOutput((prev) => [...prev, line]),
      (done) => {
        setInstalling(false);
        setInstallResult(done);
        if (done.ok) {
          // 装完刷新当前版本(读 ~/.pi-desktop/pi 新装的)
          void pi.kernel.status().then(setStatus);
          void pi.kernel.listVersions(true).then(setRegistry);
        }
      },
    );
    if (!r.ok && !installResult) {
      setInstalling(false);
      setInstallResult(r);
    }
  };

  const current = status?.currentVersion ?? null;
  const latest = registry?.latest ?? null;
  // 目标版本 vs 当前:选了不同版本就是"将切换到 X"(可能是更新也可能是降级)
  const isDowngrade = !!(current && targetVersion && current > targetVersion);
  const isUpgrade = !!(current && targetVersion && current < targetVersion);
  const isSame = !!(current && targetVersion && current === targetVersion);

  return (
    <div
      style={{
        height: "100%",
        padding: "var(--spacing-xl)",
        overflowY: "auto",
        display: "flex",
        flexDirection: "column",
        gap: "var(--spacing-lg)",
      }}
    >
      <div>
        <h2 style={{ margin: 0, fontSize: "var(--font-size-lg)", fontWeight: 600 }}>Pi 内核版本管理</h2>
        <p style={{ margin: "var(--spacing-xs) 0 0", color: "var(--color-muted)", fontSize: "var(--font-size-sm)" }}>
          只维护 <code style={{ fontFamily: "var(--font-family-mono)" }}>~/.pi-desktop/pi</code> 这一份 pi。选版本安装(装新=更新、装旧=降级),桌面端不碰 PATH 里的 pi。
        </p>
      </div>

      {/* 版本信息 */}
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-sm)" }}>
        <InfoRow label="已装版本" value={current ?? (status?.available ? "未知" : "未安装")} />
        <InfoRow label="最新版本" value={latest ?? "加载中…"} highlight={!!(latest && current && current !== latest)} />
        <InfoRow
          label="状态"
          value={
            !status?.available
              ? `未安装${status?.error ? `:${status.error}` : ""}`
              : latest && current === latest
                ? "已是最新"
                : latest && current && current !== latest
                  ? "有新版本可选装"
                  : "未知"
          }
        />
        <button onClick={() => void refresh()} disabled={checking} style={btnStyle(false)}>
          {checking ? "检查中…" : "检查最新版本"}
        </button>
      </div>

      {/* 安装/切换版本(唯一动作:装/升/降级都是 npm install 到 ~/.pi-desktop/pi)*/}
      <div style={{ borderTop: "1px solid var(--color-border)", paddingTop: "var(--spacing-lg)" }}>
        <h2 style={{ margin: 0, fontSize: "var(--font-size-lg)", fontWeight: 600 }}>安装/切换版本</h2>
        <p style={{ margin: "var(--spacing-xs) 0 0", color: "var(--color-muted)", fontSize: "var(--font-size-sm)" }}>
          选目标版本 → 安装(覆盖 <code style={{ fontFamily: "var(--font-family-mono)" }}>~/.pi-desktop/pi</code>):
          {isUpgrade && <span style={{ color: "var(--color-accent.success)" }}> 将升级 {current} → {targetVersion}</span>}
          {isDowngrade && <span style={{ color: "var(--color-accent.warning)" }}> 将降级 {current} → {targetVersion}</span>}
          {isSame && <span style={{ color: "var(--color-muted)" }}> 已是当前版本</span>}
          {!current && targetVersion && <span style={{ color: "var(--color-accent.success)" }}> 将安装 {targetVersion}</span>}
        </p>
      </div>
      <div style={{ display: "flex", gap: "var(--spacing-sm)", alignItems: "center" }}>
        <select
          value={targetVersion}
          onChange={(e) => setTargetVersion(e.target.value)}
          disabled={installing || !registry}
          style={{
            padding: "var(--spacing-xs) var(--spacing-sm)",
            border: "1px solid var(--color-border)",
            borderRadius: "var(--radius-sm)",
            background: "var(--color-surface)",
            color: "var(--color-fg)",
            fontFamily: "var(--font-family-mono)",
            fontSize: "var(--font-size-sm)",
          }}
        >
          {registry?.versions.slice().reverse().map((v) => (
            <option key={v} value={v}>
              {v}{v === latest ? " (最新)" : ""}{v === current ? " (已装)" : ""}
            </option>
          ))}
        </select>
        <button onClick={() => void install()} disabled={installing || !targetVersion || isSame} style={btnStyle(true)}>
          {installing ? "安装中…" : isDowngrade ? "降级到该版本" : isUpgrade ? "升级到该版本" : "安装该版本"}
        </button>
      </div>

      {/* 安装输出 */}
      {(installing || installOutput.length > 0 || installResult) && (
        <div>
          <div style={{ fontSize: "var(--font-size-sm)", color: "var(--color-muted)", marginBottom: "var(--spacing-xs)" }}>
            安装输出
          </div>
          <pre
            style={{
              background: "var(--color-surface)",
              border: "1px solid var(--color-border)",
              borderRadius: "var(--radius-md)",
              padding: "var(--spacing-sm) var(--spacing-md)",
              fontFamily: "var(--font-family-mono)",
              fontSize: "var(--font-size-sm)",
              color: "var(--color-fg)",
              maxHeight: "240px",
              overflowY: "auto",
              margin: 0,
              whiteSpace: "pre-wrap",
            }}
          >
            {installOutput.join("\n")}
            {installing && "…"}
            {installResult && (
              <div style={{ marginTop: "var(--spacing-xs)", color: installResult.ok ? "var(--color-accent.success)" : "var(--color-accent.error)" }}>
                {installResult.ok ? `✓ 安装完成 → ~/.pi-desktop/pi (${targetVersion})` : `✗ ${installResult.error}`}
              </div>
            )}
          </pre>
        </div>
      )}

      <div style={{ marginTop: "auto", fontSize: "var(--font-size-sm)", color: "var(--color-muted)" }}>
        pi 维护在 <code style={{ fontFamily: "var(--font-family-mono)" }}>~/.pi-desktop/pi</code>,不碰 PATH 的 pi。
      </div>
    </div>
  );
}

function InfoRow({ label, value, highlight }: { label: string; value: string; highlight?: boolean }): React.ReactNode {
  return (
    <div style={{ display: "flex", gap: "var(--spacing-md)", fontSize: "var(--font-size-sm)" }}>
      <span style={{ color: "var(--color-muted)", minWidth: "80px" }}>{label}</span>
      <span style={{ color: highlight ? "var(--color-accent.warning)" : "var(--color-fg)", fontFamily: "var(--font-family-mono)" }}>
        {value}
      </span>
    </div>
  );
}

function btnStyle(primary: boolean): React.CSSProperties {
  return {
    padding: "var(--spacing-xs) var(--spacing-md)",
    border: `1px solid ${primary ? "var(--color-primary)" : "var(--color-border)"}`,
    borderRadius: "var(--radius-sm)",
    background: primary ? "var(--color-primary)" : "transparent",
    color: primary ? "var(--color-primary-fg)" : "var(--color-fg)",
    cursor: "pointer",
    fontFamily: "var(--font-family-sans)",
    fontSize: "var(--font-size-sm)",
  };
}
