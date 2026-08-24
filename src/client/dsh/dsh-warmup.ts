// dsh 内核 warmup 实现 —— 声明 dsh 要预热,但不预生成会话标识(惰性桶名)。
//
// 依据 kernel-warmup.md:内核 warmup 能力面。dsh 会话是惰性创建的(cwd 桶名,
// 首次 session/prompt 时服务端创建),预热时无需预生成标识,故不实现 prepareSessionId。
import type { KernelWarmup } from "../../core/domain/kernel-warmup";

/** dsh warmup:预热 dsh 进程(initialize 握手),不预生成会话标识(惰性)。 */
export class DshWarmup implements KernelWarmup {
  readonly kernel = "dsh" as const;
  // 不实现 prepareSessionId:dsh 会话标识惰性(桶名),首次 prompt 时服务端创建。
}
