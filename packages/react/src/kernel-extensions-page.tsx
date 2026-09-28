// 内核拓展管理共享 UI —— 内核无关的设置页组件(内容层的共享部分)。
//
// pi-manager 与 dsh-manager 的「拓展」TAB 都挂本组件,只传 kernel 参数。
// 功能态统一(docs/core/extension-management.md §0):一根 enabled 轴,合并启用+禁用
// 单一列表;元信息(name/version/description/tags/受保护)两边同形状;重启协调经
// ctx.restart(中性)。本组件只消费 ctx.kernelExtensions(kernel) + ctx.restart,
// 不含任何内核身份分支。
import { useState, useEffect, useCallback, useMemo } from "react";
import { announceTransient } from "./widgets/live-region";
import { useTranslation } from "react-i18next";
import type { KernelExtensionInfo, KernelExtensionCapabilities, KernelId } from "@my-harness-desktop/shared";
import { SettingsSection } from "./settings-section";
import { Button } from "./widgets/button";
import { usePluginContext } from "./plugin-context";

/** 用户动作的统一兜底（r86，与 r80 的 runOp / r83 的 mutate 同款）。
 *
 *  服务端失败有**两种形态**（r80 查明）：① 返回 `{ok:false,error}`；② handler **抛错**
 *  ⇒ gateway 转成 `{ok:false,error:{code:"HANDLER_ERROR"}}`（routing/gateway.ts:61-66）
 *  ⇒ transport **reject**（ws-transport.ts:102）⇒ `await` **throw**。
 *  本文件此前只处理①（install 的 result.ok 分支），②完全没处理，后果是：
 *    · handleToggle 抛错 ⇒ 开关静默无效、loadExtensions() 不跑 ⇒ 界面停在旧状态；
 *    · handleInstall 抛错 ⇒ setInstalling(false) 走不到 ⇒ **按钮永久卡在 installing 态**；
 *    · handleRestart / handleRestartAll 抛错 ⇒ 重启静默没发生、待重启列表不刷新。
 *  ⚠ 做成**模块级**而不是组件内：本文件有两个组件（扩展页 + 待重启区），两边都要用；
 *    组件内定义会让另一个组件取不到（首版就是这么报的 TS2304）。
 *  本文件没有全局提示位，所以用发布面的命令式原语 announceTransient（r82 建）播报，
 *  错误走 role=alert 可打断；`t` 由调用方传入（模块级函数拿不到 hook）。 */
async function runGuarded(
  t: (key: string, vars?: Record<string, unknown>) => string,
  op: () => Promise<unknown>,
  failKey: string,
): Promise<boolean> {
  try {
    await op();
    return true;
  } catch (err) {
    announceTransient(t(failKey, { detail: (err as Error)?.message ?? String(err) }), "error");
    return false;
  }
}


/** tag 筛选态:tag -> "inc"(只看) | "exc"(排除);不存在的 key = 不过滤。 */
type TagFilter = Record<string, "inc" | "exc">;

export interface KernelExtensionsPageProps {
  kernel: KernelId;
  /** 区块标题(内核专属文案:pi = "PI 拓展",dsh = "DSH 拓展",由外层薄封装传翻译好的值)。 */
  title: string;
  /**
   * 安装来源输入框的占位符（内核专属：提示该内核的插件包名形状，如 `@deepseek-ai/dsh-xxx`）。
   * 不传则用语言插件里的通用占位符。
   *
   * 为什么是 prop 而不是本组件自己查 `ext.sourcePlaceholder`：那是内核专属内容，而本组件是
   * **内核无关的共享 base**（薄壳：机制在共享层、内容归插件）。此前该 key 由 pi 与 dsh 各交一份
   * 到同一个 namespace（值还不一样）——按 i18n 合并规则「同优先级先处理者胜」，
   * **谁生效取决于插件加载顺序**，于是「装哪个内核多一些」会决定另一个内核页面提示什么。
   */
  sourcePlaceholder?: string;
  refreshSignal?: number;
}

export function KernelExtensionsPage({ kernel, title, sourcePlaceholder, refreshSignal = 0 }: KernelExtensionsPageProps): React.ReactNode {
  const ctx = usePluginContext();
  // 能力面（r46）：这个页面是 pi / dsh / minimal **共用**的，而 minimal 的内核插件系统
  // 第一版未落地（install/uninstall 都直接返回失败）。此前 UI 不读能力面，
  // 于是 minimal 的页面上有一个完整可用的安装表单——用户填完来源、点安装、等一轮，
  // 才在事后看到「不支持安装拓展」。§7.6 要求的是**显式降级**（隐藏/置灰 + 说明），
  // 不是事后报错。`minimal-extension.ts` 的文件头甚至写着「壳据此置灰入口」，
  // 而壳从来没读过 capabilities——注释描述了一个不存在的行为。
  const [caps, setCaps] = useState<KernelExtensionCapabilities | null>(null);
  useEffect(() => {
    let alive = true;
    void ctx.kernelExtensions.capabilities(kernel).then((c) => { if (alive) setCaps(c); }).catch(() => { /* 取不到能力面时保持 null = 不额外限制（宁可多给入口，不静默禁掉） */ });
    return () => { alive = false; };
  }, [ctx, kernel]);

  return (
    <>
      <ListSection kernel={kernel} title={title} refreshSignal={refreshSignal} />
      <div style={{ borderTop: "2px solid var(--color-border)" }} />
      <InstallSection kernel={kernel} sourcePlaceholder={sourcePlaceholder} canInstall={caps?.install !== false} />
      <PendingRestartSection />
    </>
  );
}

function ListSection({ kernel, title, refreshSignal }: { kernel: KernelId; title: string; refreshSignal: number }): React.ReactNode {
  const { t } = useTranslation();
  const ctx = usePluginContext();
  const [extensions, setExtensions] = useState<KernelExtensionInfo[]>([]);
  const [search, setSearch] = useState("");
  const [tagFilter, setTagFilter] = useState<TagFilter>({});

  const loadExtensions = useCallback(() => {
    ctx.kernelExtensions.list(kernel).then((list) => setExtensions(list));
  }, [ctx, kernel]);

  useEffect(() => {
    loadExtensions();
  }, [loadExtensions, refreshSignal]);

  useEffect(() => {
    ctx.config.get<TagFilter>("tagFilter").then((saved) => {
      if (saved && typeof saved === "object") setTagFilter(saved);
    });
  }, [ctx]);

  /** 用户动作的统一兜底（r86，与 r80 的 runOp / r83 的 mutate 同款）。
   *
   *  服务端失败有**两种形态**（r80 查明的）：① 返回 `{ok:false,error}`；② handler **抛错**
   *  ⇒ gateway 转成 `{ok:false,error:{code:"HANDLER_ERROR"}}`（routing/gateway.ts:61-66）
   *  ⇒ transport **reject**（ws-transport.ts:102）⇒ `await` **throw**。
   *  本组件此前只处理①（install 的 result.ok 分支），②完全没处理，后果是：
   *    · handleToggle 抛错 ⇒ 开关静默无效、`loadExtensions()` 不跑 ⇒ 界面停在旧状态；
   *    · handleInstall 抛错 ⇒ `setInstalling(false)` 走不到 ⇒ **按钮永久卡在 installing 态**；
   *    · handleRestart / handleRestartAll 抛错 ⇒ 重启静默没发生、待重启列表不刷新。
   *  本组件没有自己的错误展示态，所以用发布面的命令式原语 announceTransient（r82 建、
   *  r83 起有插件侧消费方）播报，错误走 role=alert 可打断。 */
  const handleToggle = async (ext: KernelExtensionInfo): Promise<void> => {
    await runGuarded(
      t,
      () => (ext.enabled ? ctx.kernelExtensions.disable(kernel, ext.id) : ctx.kernelExtensions.enable(kernel, ext.id)),
      "ext.toggleFailed",
    );
    // 无论成败都刷新：失败时也要让界面回到服务端的**真实**状态，而不是停在我以为的那一侧
    loadExtensions();
  };

  const cycleTag = (tag: string) => {
    const next = { ...tagFilter };
    if (next[tag] === "inc") next[tag] = "exc";
    else if (next[tag] === "exc") delete next[tag];
    else next[tag] = "inc";
    setTagFilter(next);
    void ctx.config.set("tagFilter", next, { scope: "global" });
  };

  const resetTagFilter = () => {
    setTagFilter({});
    void ctx.config.set("tagFilter", {}, { scope: "global" });
  };

  const allTags = useMemo(() => {
    const present = new Set(extensions.flatMap((e) => e.tags ?? []));
    const recommended = ["desktop", "file", "local", "npm", "git", "protected"].filter((t) => present.has(t));
    const extras = [...present].filter((t) => !["desktop", "file", "local", "npm", "git", "protected"].includes(t)).sort();
    return [...recommended, ...extras];
  }, [extensions]);

  const filtered = extensions
    .filter((ext) => {
      const q = search.toLowerCase();
      return ext.name.toLowerCase().includes(q) || ext.description?.toLowerCase().includes(q);
    })
    .filter((ext) => {
      const inc = Object.keys(tagFilter).filter((k) => tagFilter[k] === "inc");
      const exc = Object.keys(tagFilter).filter((k) => tagFilter[k] === "exc");
      if (inc.length && !ext.tags.some((t) => inc.includes(t))) return false;
      if (exc.length && ext.tags.some((t) => exc.includes(t))) return false;
      return true;
    })
    .sort((a, b) => {
      if (Boolean(a.disallowOff) !== Boolean(b.disallowOff)) return a.disallowOff ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  if (extensions.length === 0) {
    return (
      <SettingsSection title={title}>
        <p style={{ color: "var(--color-muted)", fontSize: "var(--font-size-sm)", margin: 0 }}>
          {t("ext.empty")}
        </p>
      </SettingsSection>
    );
  }

  return (
    <SettingsSection title={title}>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-md)" }}>
        <input
          type="text"
          placeholder={t("ext.search")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            padding: "var(--spacing-xs) var(--spacing-sm)",
            border: "1px solid var(--color-border)",
            borderRadius: "var(--radius-sm)",
            background: "var(--color-surface)",
            color: "var(--color-fg)",
            fontFamily: "var(--font-family-sans)",
            fontSize: "var(--font-size-sm)",
          }}
        />

        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--spacing-xs)", alignItems: "center" }}>
          {allTags.map((tag) => {
            const st = tagFilter[tag];
            const count = extensions.filter((e) => (e.tags ?? []).includes(tag)).length;
            return (
              <button
                key={tag}
                onClick={() => cycleTag(tag)}
                style={{
                  cursor: "pointer",
                  padding: "2px 10px",
                  fontSize: "var(--font-size-xs)",
                  borderRadius: "var(--radius-md)",
                  border: `1px ${st ? "solid" : "dashed"} ${st === "inc" ? "var(--color-primary)" : st === "exc" ? "var(--color-accent-error)" : "var(--color-border)"}`,
                  background: st === "inc" ? "var(--color-primary)" : "transparent",
                  color: st === "inc" ? "var(--color-primary-fg)" : st === "exc" ? "var(--color-accent-error)" : "var(--color-muted)",
                  textDecoration: st === "exc" ? "line-through" : "none",
                }}
              >
                {t(`ext.tag.${tag}`, { defaultValue: tag })} {count}
              </button>
            );
          })}
          {Object.keys(tagFilter).length > 0 && (
            <button
              onClick={resetTagFilter}
              style={{ cursor: "pointer", border: "none", background: "transparent", color: "var(--color-primary)", fontSize: "var(--font-size-xs)", textDecoration: "underline", padding: "2px 4px" }}
            >
              {t("ext.filterReset")}
            </button>
          )}
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
            gap: "var(--spacing-sm)",
          }}
        >
          {filtered.map((ext) => (
            <ExtensionCard
              key={ext.id}
              ext={ext}
              canToggle={!ext.disallowOff}
              onToggle={() => void handleToggle(ext)}
            />
          ))}
        </div>

        {filtered.length === 0 && (
          <p style={{ color: "var(--color-muted)", fontSize: "var(--font-size-sm)", textAlign: "center", padding: "var(--spacing-lg) 0" }}>
            {t("ext.noMatch")}
          </p>
        )}
      </div>
    </SettingsSection>
  );
}

function ExtensionCard({
  ext,
  canToggle,
  onToggle,
}: {
  ext: KernelExtensionInfo;
  canToggle: boolean;
  onToggle: () => void;
}): React.ReactNode {
  const { t } = useTranslation();

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--spacing-sm)",
        padding: "var(--spacing-md)",
        border: "1px solid var(--color-border)",
        borderRadius: "var(--radius-md)",
        background: "var(--color-surface)",
        opacity: ext.enabled ? 1 : 0.55,
        transition: "border-color 0.15s, opacity 0.15s",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "var(--spacing-xs)" }}>
        <span style={{ fontWeight: 600, color: "var(--color-fg)", fontSize: "var(--font-size-sm)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {ext.name}
        </span>
        {ext.disallowOff && (
          <span style={{ fontSize: "var(--font-size-xs)", color: "var(--color-accent-warning)" }}>
            &#128274;
          </span>
        )}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: "var(--spacing-xs)" }}>
        {ext.version && (
          <span style={{ fontSize: "var(--font-size-xs)", color: "var(--color-muted)", fontFamily: "var(--font-family-mono)" }}>
            v{ext.version}
          </span>
        )}
        {(ext.tags ?? []).map((tag) => {
          const isProtected = tag === "protected";
          return (
            <span
              key={tag}
              style={{
                fontSize: "var(--font-size-xs)",
                color: isProtected ? "var(--color-accent-warning)" : "var(--color-muted)",
                border: `1px solid ${isProtected ? "var(--color-accent-warning)" : "var(--color-border)"}`,
                padding: "0 var(--spacing-xs)",
                borderRadius: "var(--radius-sm)",
                fontFamily: "var(--font-family-mono)",
              }}
            >
              {t(`ext.tag.${tag}`, { defaultValue: tag })}
            </span>
          );
        })}
      </div>

      {ext.description && (
        <div style={{ fontSize: "var(--font-size-xs)", color: "var(--color-muted)", lineHeight: 1.4, minHeight: "1.4em" }}>
          {ext.description}
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", marginTop: "auto" }}>
        {canToggle ? (
          <ToggleSwitch checked={ext.enabled} onChange={onToggle} />
        ) : (
          <span style={{ fontSize: "var(--font-size-xs)", color: "var(--color-muted)" }}>
            {t("ext.protected")}
          </span>
        )}
      </div>
    </div>
  );
}

function ToggleSwitch({ checked, onChange }: { checked: boolean; onChange: () => void }): React.ReactNode {
  return (
    <div
      onClick={(e) => { e.stopPropagation(); onChange(); }}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--spacing-xs)",
        cursor: "pointer",
        userSelect: "none",
      }}
    >
      <span style={{ fontSize: "var(--font-size-xs)", color: checked ? "var(--color-fg)" : "var(--color-muted)", fontWeight: 500 }}>
        {checked ? "ON" : "OFF"}
      </span>
      <div
        style={{
          width: "36px",
          height: "20px",
          borderRadius: "10px",
          background: checked ? "var(--color-primary)" : "var(--color-border)",
          position: "relative",
          transition: "background 0.2s",
          flexShrink: 0,
        }}
      >
        <div
          style={{
            position: "absolute",
            top: "2px",
            left: checked ? "18px" : "2px",
            width: "16px",
            height: "16px",
            borderRadius: "50%",
            background: "var(--color-primary-fg)",
            transition: "left 0.2s",
          }}
        />
      </div>
    </div>
  );
}

function InstallSection({ kernel, sourcePlaceholder, canInstall }: { kernel: KernelId; sourcePlaceholder?: string; canInstall: boolean }): React.ReactNode {
  const { t } = useTranslation();
  const ctx = usePluginContext();
  const [installSource, setInstallSource] = useState("");
  const [installing, setInstalling] = useState(false);
  const [installProgress, setInstallProgress] = useState("");

  const handleInstall = async (): Promise<void> => {
    if (!installSource.trim() || installing) return;
    setInstalling(true);
    setInstallProgress("");
    // ⚠ try/finally 保证**无论成败都解除 installing 态**（r86 的卡死根因，与 r80 同款）。
    try {
      const result = await ctx.kernelExtensions.install(kernel, installSource.trim(), (line) => {
        setInstallProgress((prev) => prev + line);
      });
      if (result.ok) {
        setInstallSource("");
        setInstallProgress("");
      } else {
        setInstallProgress(result.error ?? t("ext.installFailed"));   // 形态①：返回值
      }
    } catch (err) {
      // 形态②：抛错/reject —— 进度区显示原因（这个组件没有全局提示位，进度区就是它的反馈位）
      setInstallProgress(t("ext.installFailed") + ": " + ((err as Error)?.message ?? String(err)));
    } finally {
      setInstalling(false);
    }
  };

  // 显式降级（§7.6）：这个内核没有安装能力时，**不给表单**，改成一句说明。
    // 关键差别不是"少一个按钮"，而是**失败发生的时机**：给表单 = 用户填完来源、点安装、
    // 等一轮，才在事后看到「不支持安装拓展」；不给表单 + 说明 = 用户在动手之前就知道。
    // ⚠ 保留区块标题（不是整块消失）：静默消失会让人以为功能坏了或自己找错了页面。
    if (!canInstall) {
      return (
        <SettingsSection title={t("ext.install")}>
          <div
            data-ext-install-unsupported=""
            style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-xs)", padding: "var(--spacing-sm) 0" }}
          >
            <span style={{ color: "var(--color-fg)", fontSize: "var(--font-size-sm)" }}>{t("ext.installUnsupported")}</span>
            <span style={{ color: "var(--color-muted)", fontSize: "var(--font-size-xs)" }}>{t("ext.installUnsupportedHint")}</span>
          </div>
        </SettingsSection>
      );
    }

  return (
    <SettingsSection title={t("ext.install")}>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-sm)" }}>
        <div style={{ display: "flex", gap: "var(--spacing-sm)", alignItems: "center" }}>
          <span style={{ color: "var(--color-muted)", fontSize: "var(--font-size-sm)", minWidth: "60px" }}>
            {t("ext.source")}
          </span>
          <input
            type="text"
            placeholder={sourcePlaceholder ?? t("ext.sourcePlaceholder")}
            value={installSource}
            onChange={(e) => setInstallSource(e.target.value)}
            disabled={installing}
            style={{
              flex: 1,
              padding: "var(--spacing-xs) var(--spacing-sm)",
              border: "1px solid var(--color-border)",
              borderRadius: "var(--radius-sm)",
              background: "var(--color-surface)",
              color: "var(--color-fg)",
              fontFamily: "var(--font-family-mono)",
              fontSize: "var(--font-size-sm)",
            }}
          />
          <Button
            variant="primary"
            onClick={() => void handleInstall()}
            disabled={installing || !installSource.trim()}
          >
            {installing ? t("ext.installing") : t("ext.install")}
          </Button>
        </div>
        {installProgress && (
          <pre style={{
            background: "var(--color-surface)",
            border: "1px solid var(--color-border)",
            borderRadius: "var(--radius-sm)",
            padding: "var(--spacing-sm) var(--spacing-md)",
            fontFamily: "var(--font-family-mono)",
            fontSize: "var(--font-size-xs)",
            color: "var(--color-muted)",
            maxHeight: "200px",
            overflowY: "auto",
            margin: 0,
            whiteSpace: "pre-wrap",
          }}>
            {installProgress}
          </pre>
        )}
      </div>
    </SettingsSection>
  );
}

function PendingRestartSection(): React.ReactNode {
  const { t } = useTranslation();
  const ctx = usePluginContext();
  const [sessions, setSessions] = useState<{ sessionKey: string; state: { status: string } }[]>([]);

  const loadPending = useCallback(() => {
    ctx.restart.pendingSessions().then((s) => {
      setSessions(s as { sessionKey: string; state: { status: string } }[]);
    });
  }, [ctx]);

  useEffect(() => {
    loadPending();
    const unsub = ctx.restart.onStateChange(() => loadPending());
    return unsub;
  }, [loadPending, ctx]);

  const handleRestart = async (sessionKey: string): Promise<void> => {
    await runGuarded(t, () => ctx.restart.restart(sessionKey), "ext.restartFailed");
    loadPending();   // 失败也要刷新，让列表回到真实状态
  };

  const handleRestartAll = async (): Promise<void> => {
    await runGuarded(t, () => ctx.restart.restartAllIdle(), "ext.restartFailed");
    loadPending();
  };

  if (sessions.length === 0) return null;

  return (
    <div style={{ marginTop: "var(--spacing-xl)" }}>
      <SettingsSection title={t("ext.pendingRestart")}>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-xs)" }}>
          {sessions.map((s) => (
            <div key={s.sessionKey} style={{ display: "flex", gap: "var(--spacing-sm)", alignItems: "center" }}>
              <span style={{ color: "var(--color-fg)", fontSize: "var(--font-size-sm)" }}>
                {s.sessionKey.split("/").pop() ?? s.sessionKey}
              </span>
              <span style={{ color: "var(--color-muted)", fontSize: "var(--font-size-xs)" }}>
                [{s.state.status}]
              </span>
              {s.state.status === "pending" && (
                <button
                  onClick={() => void handleRestart(s.sessionKey)}
                  style={{
                    padding: "2px var(--spacing-sm)",
                    border: "1px solid var(--color-border)",
                    borderRadius: "var(--radius-sm)",
                    background: "transparent",
                    color: "var(--color-fg)",
                    fontSize: "var(--font-size-xs)",
                    cursor: "pointer",
                    fontFamily: "var(--font-family-sans)",
                  }}
                >
                  {t("ext.reload")}
                </button>
              )}
            </div>
          ))}
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "var(--spacing-sm)" }}>
            <button
              onClick={() => void handleRestartAll()}
              style={{
                padding: "var(--spacing-xs) var(--spacing-md)",
                border: "1px solid var(--color-primary)",
                borderRadius: "var(--radius-sm)",
                background: "var(--color-primary)",
                color: "var(--color-primary-fg)",
                fontSize: "var(--font-size-sm)",
                cursor: "pointer",
                fontFamily: "var(--font-family-sans)",
              }}
            >
              {t("ext.reloadAll")}
            </button>
          </div>
        </div>
      </SettingsSection>
    </div>
  );
}
