// pi 内核 warmup 实现 —— 声明 pi 预热时要预生成会话文件路径。
//
// 依据 kernel-warmup.md:内核 warmup 能力面,与 PiBackend/PiModelSource 并列。
// 起进程的通用逻辑由 session-store 复用 createProc;本实现只声明「预生成文件路径」。
import type { KernelWarmup } from "@my-harness-desktop/shared";
import type { SessionCatalogFactory } from "@my-harness-desktop/shared";

/** pi warmup:预热时预生成会话文件路径(pi 需要文件,懒建会话)。 */
export class PiWarmup implements KernelWarmup {
  readonly kernel = "pi" as const;
  constructor(private readonly catalogFactory: SessionCatalogFactory) {}

  prepareSessionId(cwd: string): string | null {
    return this.catalogFactory.create("pi").newSessionId(cwd);
  }
}
