// dsh 内核版本管理实现 —— client/dsh 流出适配器(实现层)。
//
// DshKernelManager extends KernelManager(基类):填 DSH_SPEC(数据)+ 无 postInstall,
// 另加 dsh 独有的 installPlugin(装 cordis 插件 = npm install + 写 cordis.yml 项,
// cordis.yml 写项由外层 DshConfigSource 完成,本文件只管 npm install 这一半)。
// 依赖方向只向内:client import core/application(基类)+ core/domain(契约)。

import type { KernelSpec } from "@my-harness-desktop/shared";
import { KernelManager } from "../../core/kernel-manager";

/** dsh 内核 npm 包(JSON-RPC 运行时:dsh-jsonrpc-agent bin + 一套插件)。
 *  主包只带 bin/boot;插件(sdk-jsonrpc-server/agent 核心/DeepSeek 适配器/会话/工具)由
 *  cordis.yml 按包名解析,须一并装进同一 node_modules。 */
export const DSH_SPEC: KernelSpec = {
  pkg: "@deepseek-ai/dsh-sdk-jsonrpc-demo",
  distTag: "next",
  pkgJsonPath: ["node_modules", "@deepseek-ai", "dsh-sdk-jsonrpc-demo", "package.json"],
  extraPackages: [
    "@deepseek-ai/dsh-sdk-jsonrpc-server",
    "@deepseek-ai/dsh-agent-spine-demo",
    "@deepseek-ai/dsh-llm-deepseek",
    "@deepseek-ai/dsh-settings-file",
    "@deepseek-ai/dsh-llm-pi-ai",
    "@deepseek-ai/dsh-session-persistence-jsonl",
    "@deepseek-ai/dsh-session-checkpoint-policy",
    "@deepseek-ai/dsh-subprocess-local",
    "@deepseek-ai/dsh-bash-local",
    "@deepseek-ai/dsh-fs-local",
  ],
  cliWithinPkg: ["lib", "bin.js"],
  srcCli: ["packages", "examples", "jsonrpc-demo", "lib", "bin.js"],
  srcPkgJson: ["packages", "examples", "jsonrpc-demo", "package.json"],
  cliJsLabel: "apps/cli/lib/bin.js",
};

/**
 * dsh 内核版本管理。postInstall 无操作(dsh 无装后补丁)。
 * installPlugin:dsh 独有的「装 cordis 插件」——钉到已装内核同版本,不写版本会落到
 * latest(陈旧 0.0.1-rc.x)与新内核 peer deps 冲突(与 install 的附带包同根因)。
 */
export class DshKernelManager extends KernelManager {
  protected postInstall(_onProgress: (line: string) => void): void {
    // dsh 无安装后补丁。
  }

  /** 安装 dsh Cordis 插件:直接 npm install 进 dsh 内核目录(复用其 package.json + node_modules)。
   *  包名白名单只放 @deepseek-ai/dsh-* 前缀,防 npm spec 注入。 */
  async installPlugin(
    pkgName: string,
    onProgress: (line: string) => void,
  ): Promise<{ ok: boolean; error: string | null }> {
    if (!/^@deepseek-ai\/dsh-[a-z0-9-]+$/.test(pkgName)) {
      return { ok: false, error: `非法插件包名: ${pkgName}` };
    }
    const installed = this.currentVersion();
    if (!installed.available || !installed.currentVersion) {
      return { ok: false, error: "dsh 内核未安装,先安装内核再装插件" };
    }
    return this.installNpm(`${pkgName}@${installed.currentVersion}`, onProgress);
  }

  /** 卸载 dsh Cordis 插件:npm uninstall 出内核目录(装/卸对称,同白名单)。 */
  async uninstallPlugin(
    pkgName: string,
    onProgress: (line: string) => void,
  ): Promise<{ ok: boolean; error: string | null }> {
    if (!/^@deepseek-ai\/dsh-[a-z0-9-]+$/.test(pkgName)) {
      return { ok: false, error: `非法插件包名: ${pkgName}` };
    }
    return this.uninstallNpm(pkgName, onProgress);
  }
}
