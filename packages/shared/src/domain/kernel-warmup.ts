// 圆心:内核 warmup 能力契约 —— 每个内核一个 warmup 实现,与 BaseBackend/KernelModelSource 并列。
//
// 依据多内核默认(§1.5):warmup 是内核的固定能力之一,壳经本契约调用,不硬编码内核。
// 未注册实现的内核 = 不 warmup,选模型时按需起进程(框架支持「有 warmup / 无 warmup」两种)。
//
// 本文件零依赖:只 import domain 内部的 KernelId,是圆心最内层的契约原子。

import type { KernelId } from "./kernel";

/**
 * 内核 warmup 能力:一个要预热的内核提供一个实现。
 * 起进程的通用逻辑(createProc + start)由 session-store 复用;实现只声明「预热时的内核专属准备」。
 * 加第三个内核 = 加一个 KernelWarmup 实现 + 注册一行,session-store 零改动。
 */
export interface KernelWarmup {
  /** 本 warmup 服务的内核。 */
  readonly kernel: KernelId;
  /** 预热时的会话标识准备(可选):pi 预生成文件路径,dsh 惰性返回 null(桶名)。
   *  返回 null 或未实现 = 不预生成,由后端惰性处理。 */
  prepareSessionId?(cwd: string): string | null;
}
