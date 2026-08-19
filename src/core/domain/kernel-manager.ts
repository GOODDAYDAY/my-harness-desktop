// 圆心:内核版本管理契约(纯类型 + 路径段数据,零依赖)。
//
// 依据 docs/design/kernel-layer.md:pi/dsh 共用同一套版本管理机制,差异只在
// 「包名 + 安装路径段 + cli.js 位置」。KernelSpec 只放这些数据,通用逻辑(装/查/
// 状态合成)在 core/application/kernel 的 KernelManager 基类,具体内核的 spec 值在
// client/pi、client/dsh(实现层)。圆心零依赖:只 import domain 内部的 KernelStatusView。

import type { KernelStatusView } from "./context";

/** 一个内核的 npm 安装形态 + 自定义目录归一化路径段。 */
export interface KernelSpec {
  /** npm 主包名。 */
  pkg: string;
  /** installDir 下到主包 package.json 的相对段(npm 形态,含 package.json)。 */
  pkgJsonPath: string[];
  /** 附带插件包(dsh 的 JSON-RPC 运行时是「bin + 插件」组合,须与主包同版本一并装)。 */
  extraPackages?: string[];
  /** npm 包根(pkgJsonPath 去掉 package.json)下到 cli.js 的相对段(自定义目录形态二)。 */
  cliWithinPkg: string[];
  /** 源码根下到 cli.js 的相对段(自定义目录形态一:开发仓库 build 后,优先)。 */
  srcCli: string[];
  /** 源码根下到 package.json 的相对段(形态一)。 */
  srcPkgJson: string[];
  /** 自定义目录校验失败时展示的 cli.js 名(错误文案 hint)。 */
  cliJsLabel: string;
}

/** registry 查询结果。 */
export interface RegistryVersions {
  versions: string[];
  latest: string | null;
}

/** 自定义底座归一化结果。 */
export interface CustomCliResolution {
  /** cli.js 绝对路径(spawn 用)。 */
  cliJs: string;
  /** 包 package.json 的 version(读不到为 null,不因此判无效)。 */
  version: string | null;
}

/** 数据根安装状态(kernel status 的零件;不含生效来源维度——那是 status 的职责)。 */
export type InstalledVersionStatus = Pick<KernelStatusView, "currentVersion" | "available" | "error">;
