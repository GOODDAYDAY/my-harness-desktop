// pi 后端 —— BaseBackend 的 pi 实现:收编 client/pi 传输 + resync 基线 + pi 命令构造。
//
// 依据 docs/design/base-interface-lineage.md §3.1。pi 的协议(JSONL 31 命令)、会话文件、
// parentId 树,全部收编在本后端内部;对外只暴露 BaseBackend 中性操作。
//
// 当前形态是「会话级后端」:一个 PiBackend 绑一个 RpcAdapter(即一个 pi 进程、一个激活会话)。
// getTree/getEntries 因此只对激活会话生效(RPC 基线);读任意非激活会话的树/条目,
// 需要会话文件 IO(session-scanner),是后续接线步骤的事。
//
// bookmark/resume 需要会话文件上下文(cwd/agentDir/源会话路径),本类只收 RpcAdapter,
// 故暂不接线——两者是「pi 后端私有」的文件编排,接线时把 session-scanner.copySession 与
// forkFromSession 编排搬进来即可(见 §3.1.2/§3.1.3)。

import type { RpcAdapter } from "../../../client/pi/rpc-adapter";
import type { BaseBackend, Anchor, BoundaryRef, LineageTree } from "../../domain/backend";
import { projectLineageTree } from "../../domain/backend";
import { resync } from "../orchestrations/resync";
import {
  buildPromptCommand,
  buildAbortCommand,
  buildSetModelCommand,
  buildForkCommand,
} from "../../protocol/commands";
import { translateEvent } from "../../protocol/event-translator";
import type { SessionEvent, NeutralMessage } from "../../domain/events/session-state";

/** pi 后端:把 RpcAdapter + 命令构造收编成一个 BaseBackend 实现。 */
export class PiBackend implements BaseBackend {
  constructor(private readonly adapter: RpcAdapter) {}

  get alive(): boolean {
    return this.adapter.alive;
  }

  async start(): Promise<void> {
    await this.adapter.start();
  }

  async stop(): Promise<void> {
    await this.adapter.stop();
  }

  /** 订阅中性事件流(pi 事件经 translateEvent 投成中性)。 */
  onEvent(cb: (event: SessionEvent) => void): () => void {
    return this.adapter.onEvent((event) => cb(translateEvent(event)));
  }

  async sendMessage(text: string): Promise<void> {
    await this.adapter.send(buildPromptCommand({ message: text }));
  }

  async abort(): Promise<void> {
    await this.adapter.send(buildAbortCommand());
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    await this.adapter.send(buildSetModelCommand({ provider, modelId }));
  }

  /**
   * fork:pi 从激活会话的 boundary(entryId)分叉,底座切到新会话文件。
   * parentLineageId 对 pi 冗余(pi 总 fork 激活会话),忽略;boundary 即 entryId。
   * 返回新会话文件路径作新 lineage id(与 §3.1.1「分叉产物 = 新 lineage」一致)。
   */
  async fork(parentLineageId: string, boundary?: BoundaryRef): Promise<string> {
    if (!boundary) throw new Error("pi 后端 fork 必须给 boundary(entryId)");
    await this.adapter.send(buildForkCommand(boundary, "at"));
    const snapshot = await resync(this.adapter);
    const sessionFile = snapshot.state.sessionFile;
    if (typeof sessionFile !== "string" || !sessionFile) {
      throw new Error("fork 后未拿到新会话文件(底座未切换)");
    }
    return sessionFile;
  }

  /** getTree:激活会话的入口级树 → lineage 树(RPC get_tree 经 resync 投影)。 */
  async getTree(sessionId: string): Promise<LineageTree> {
    const snapshot = await resync(this.adapter);
    return projectLineageTree(snapshot.tree);
  }

  /** getEntries:激活会话的线性消息历史(RPC get_entries 经 resync 投影)。 */
  async getEntries(lineageId: string): Promise<NeutralMessage[]> {
    const snapshot = await resync(this.adapter);
    return snapshot.messages;
  }

  /** bookmark:未接线——需会话文件拷贝(session-scanner.copySession + agentDir)。 */
  async bookmark(lineageId: string, boundary: BoundaryRef): Promise<Anchor> {
    throw new Error("pi 后端 bookmark 未接线(需会话文件上下文)");
  }

  /** resume:未接线——需 forkFromSession 编排(拷贝 → start → fork → 删中间副本)。 */
  async resume(anchor: Anchor): Promise<string> {
    throw new Error("pi 后端 resume 未接线(需会话文件上下文)");
  }
}
