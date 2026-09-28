// 内核版本管理的中性包装(§kernel-plugin) —— KernelManager(装/升/降级) → KernelVersionApi。
//
// pi/dsh 的版本管理逻辑几乎一样(读 customCliDir → status / 校验 → 写 prefs → 标重启 → 返回
// 新 status / listVersions / install),差异只在 prefs key + resolveCustomCli 的失败文案。
// 收敛成一份通用包装,pi/dsh 插件各自传参数——机制在 core,内核专属数据(文案/key)由插件传。

import type { KernelVersionApi } from "@my-harness-desktop/shared";
import type { KernelManager } from "./kernel-manager";

export interface WrapVersionApiOptions {
  /** 自定义内核目录的 prefs key(pi=customCliDir / dsh=dshCustomCliDir)。 */
  customCliPrefsKey: string;
  /** resolveCustomCli 校验失败时的文案(pi 找 dist/cli.js,dsh 找 apps/cli/lib/bin.js)。 */
  customCliError: string;
  prefs: { get<T>(key: string): T | undefined; set<T>(key: string, value: T): void };
  /** 配置变更标记运行中会话重启(version 的 setCustomCliDir 用)。 */
  markPending: (reason: string) => void;
  /** 安装/切换完成后的通用刷新信号。 */
  refresh: () => void;
  /** 该内核能否强制执行工具白名单（语义见圆心 `KernelVersionApi.toolFilterEnforced`）。
   *  缺省 false = 该内核不声明此面，壳按「不能强制过滤」显式降级。 */
  toolFilterEnforced?: () => boolean;
}

/** 把 KernelManager 包装成中性 KernelVersionApi(§kernel-plugin)。 */
export function wrapVersionApi(manager: KernelManager, opts: WrapVersionApiOptions): KernelVersionApi {
  return {
    // KernelManager 走的是"装/切版本"这条路 —— 用它包装的内核天然支持这两面。
    // 内置内核（minimal）不经过本包装，自己交 { install: false, customDir: false }。
    capabilities: () => Promise.resolve({ install: true, customDir: true }),
    status: () => Promise.resolve(manager.status(opts.prefs.get<string>(opts.customCliPrefsKey) ?? "")),
    setCustomCliDir: (dir) => {
      const trimmed = (dir ?? "").trim();
      if (trimmed && !manager.resolveCustomCli(trimmed)) {
        return Promise.resolve({ ok: false, error: opts.customCliError, pendingCount: 0, status: null });
      }
      opts.prefs.set(opts.customCliPrefsKey, trimmed);
      opts.markPending("自定义内核路径变更");
      opts.refresh();
      return Promise.resolve({ ok: true, error: null, pendingCount: 0, status: manager.status(trimmed) });
    },
    listVersions: (forceRefresh = false) => manager.listVersions(forceRefresh),
    install: (version, onProgress, onDone) => {
      const p = manager.install(version, onProgress);
      p.then((r) => {
        if (r.ok) opts.refresh();
        onDone(r);
      });
      return p;
    },
    toolFilterEnforced: () => Promise.resolve(opts.toolFilterEnforced?.() ?? false),
  };
}
