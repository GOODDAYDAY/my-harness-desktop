// pi-kernel-manager 插件 renderer —— pi 内核管理设置页。
//
// 走文档路线(structure/18 §4.5.1):spawn `pi update` 让底座自己更新,
// 桌面端不下载、不替换底座文件、不 spawn npm。
// - 当前版本:spawn `pi --version`(经 application/kernel)
// - 最新版本:fetch npm registry(经 application/kernel,只查版本号)
// - 触发更新:spawn `pi update`,stdout 实时显示
//
// 纯 renderer 插件(无 main),贡献 settings 槽一项(component=KernelSettings)。
// ⚠ 同 theme-manager:renderer 直连 shell 经 @ alias,演进待 @pi-desktop/react 包(盲审 H1)。
import { useEffect, useState } from "react";
import { registerSettingsComponent } from "@/shell/renderer/settings-components";

registerSettingsComponent("KernelSettings", KernelSettings);

interface KernelStatus {
  currentVersion: string | null;
  available: boolean;
  error: string | null;
}

export function KernelSettings(): React.ReactNode {
  const [status, setStatus] = useState<KernelStatus | null>(null);
  const [registry, setRegistry] = useState<{ versions: string[]; latest: string | null } | null>(null);
  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [updateOutput, setUpdateOutput] = useState<string[]>([]);
  const [updateResult, setUpdateResult] = useState<{ ok: boolean; error: string | null } | null>(null);

  // 启动:拉当前状态 + registry 版本
  useEffect(() => {
    void window.pi.kernel.status().then(setStatus);
    void window.pi.kernel.listVersions().then(setRegistry);
  }, []);

  const checkUpdate = async (): Promise<void> => {
    setChecking(true);
    try {
      const r = await window.pi.kernel.listVersions(true);
      setRegistry(r);
    } finally {
      setChecking(false);
    }
  };

  const triggerUpdate = async (): Promise<void> => {
    setUpdating(true);
    setUpdateOutput([]);
    setUpdateResult(null);
    const r = await window.pi.kernel.update(
      (line) => setUpdateOutput((prev) => [...prev, line]),
      (done) => {
        setUpdating(false);
        setUpdateResult(done);
        if (done.ok) {
          void window.pi.kernel.status().then(setStatus);
          void window.pi.kernel.listVersions(true).then(setRegistry);
        }
      },
    );
    // invoke 返回值与 onDone 是同一份;非 0 退出兜底(避免 main 异常时卡 updating)
    if (!r.ok && !updateResult) {
      setUpdating(false);
      setUpdateResult(r);
    }
  };

  const current = status?.currentVersion ?? null;
  const latest = registry?.latest ?? null;
  // 不替用户决策"该不该更新"(盲审 H1/L3:版本决策归底座,桌面端只展示),用户自己看版本号判断
  const newerAvailable = !!(current && latest && current !== latest);

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
        <h2 style={{ margin: 0, fontSize: "var(--font-size-lg)", fontWeight: 600 }}>Pi 内核管理</h2>
        <p style={{ margin: "var(--spacing-xs) 0 0", color: "var(--color-muted)", fontSize: "var(--font-size-sm)" }}>
          管理 pi 底座版本。更新走 pi 自己的 <code style={{ fontFamily: "var(--font-family-mono)" }}>pi update</code>,桌面端不下载替换。
        </p>
      </div>

      {/* 版本信息 */}
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-sm)" }}>
        <InfoRow label="当前版本" value={current ?? (status?.available ? "未知" : "未安装")} />
        <InfoRow label="最新版本" value={latest ?? "加载中…"} highlight={newerAvailable} />
        <InfoRow
          label="状态"
          value={
            !status?.available
              ? `pi 不可用${status?.error ? `:${status.error}` : ""}`
              : newerAvailable
                ? "有更新可用(自行判断是否更新)"
                : latest && current === latest
                  ? "已是最新"
                  : "未知"
          }
        />
      </div>

      {/* 操作按钮 */}
      <div style={{ display: "flex", gap: "var(--spacing-sm)" }}>
        <button
          onClick={() => void checkUpdate()}
          disabled={checking}
          style={btnStyle(false)}
        >
          {checking ? "检查中…" : "检查更新"}
        </button>
        <button
          onClick={() => void triggerUpdate()}
          disabled={updating || !status?.available}
          style={btnStyle(true)}
        >
          {updating ? "更新中…" : "触发更新"}
        </button>
      </div>

      {/* 更新输出 */}
      {(updating || updateOutput.length > 0 || updateResult) && (
        <div>
          <div style={{ fontSize: "var(--font-size-sm)", color: "var(--color-muted)", marginBottom: "var(--spacing-xs)" }}>
            更新输出
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
            {updateOutput.join("\n")}
            {updating && "…"}
            {updateResult && (
              <div style={{ marginTop: "var(--spacing-xs)", color: updateResult.ok ? "var(--color-accent.success)" : "var(--color-accent.error)" }}>
                {updateResult.ok ? "✓ 更新完成" : `✗ ${updateResult.error}`}
                {!updateResult.ok && (
                  <div style={{ marginTop: "var(--spacing-xs)", color: "var(--color-muted)", fontSize: "var(--spacing-sm)" }}>
                    底座可能不支持当前安装方式的自更新(bun-binary/Windows+bun 等),请按上方输出底座给的指引操作,或去 Release 页下载。
                  </div>
                )}
              </div>
            )}
          </pre>
          {updateResult?.ok && (
            <div style={{ marginTop: "var(--spacing-sm)", fontSize: "var(--font-size-sm)", color: "var(--color-muted)" }}>
              更新完成。RPC 接入后将自动重启子进程;当前请手动重启壳使新版本生效。
            </div>
          )}
        </div>
      )}

      <div style={{ marginTop: "auto", fontSize: "var(--font-size-sm)", color: "var(--color-muted)" }}>
        走文档路线:spawn <code style={{ fontFamily: "var(--font-family-mono)" }}>pi update</code>,底座自己管更新。
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
