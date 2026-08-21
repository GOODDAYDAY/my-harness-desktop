// kernel 运行时抽象 —— application 层拥有的依赖倒置接口。
//
// 评估 P2:kernel-manager 此前在 application 层直接 spawn("npm") + 读 process.env +
// fetch npm registry,违反"application 不装进程管理/环境感知"(§6.2)。依赖倒置:
// 本接口在 application 定义(消费方拥有抽象),实现由 shell 注入(spawn/fetch/env 都是
// 外层会变的细节)。换运行时(从 Electron 换 CLI、从本地换远程)只换 shell 实现,
// kernel-manager 一行不改。同 RpcAdapterFactory/SubprocessHandle 模式(§3.4)。
import type { RegistryVersions } from "../../domain/kernel-manager";

/** 进程安装 + registry 查询 + 环境提供(spawn/fetch/env 是会变的外层细节,推到 shell)。 */
export interface KernelRuntime {
  /** spawn npm install 指定包到 installDir,stdout/stderr 行转发 onProgress。
   *  env 由实现侧用 allowlist(不继承宿主凭证)。返回 exit 结果。 */
  installNpm(
    pkgSpec: string,
    installDir: string,
    onProgress: (line: string) => void,
  ): Promise<{ ok: boolean; error: string | null }>;

  /** spawn npm uninstall 指定包(装/卸对称,用于内核拓展卸载)。 */
  uninstallNpm(
    pkgSpec: string,
    installDir: string,
    onProgress: (line: string) => void,
  ): Promise<{ ok: boolean; error: string | null }>;

  /** fetch npm registry 拿某包的版本清单 + 指定 dist-tag 的最新版本(网络是外层细节)。 */
  fetchRegistryVersions(pkgName: string, distTag?: string): Promise<RegistryVersions>;
}
