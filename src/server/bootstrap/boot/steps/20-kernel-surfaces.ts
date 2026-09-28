// 步骤 20：把内核注册表投影成壳需要的全部中性面。
//
// 收编设计文档 §1.1.2 的动作 #4。`buildKernelSurfaces` 单独成文件的理由（`kernel-surfaces.ts`
// 文件头）是：让"加第四个内核零改动"这句话**可被测试直接证明**，而不是靠读代码相信——
// 该函数体内零内核名，`kernel-surfaces.test.ts` 用一个第四内核 fixture + 源码扫描断言守住。
//
// **为什么 fatal**：投影面是后续几乎所有步骤的输入（技能挂摘、扩展同步、提问桥、模型合流、
// MainContext 的九个派生字段）。投影失败 = 壳没有任何内核面可用。
import type { BootStep } from "../types";
import { buildKernelSurfaces } from "../../kernel-surfaces";

const step: BootStep = {
  id: "20-kernel-surfaces",
  scope: "global",
  failure: "fatal",
  requires: ["10-kernel-plugins"],
  run(ctx) {
    // accessors 由 10-kernel-plugins 与注册表同批创建（memo 缓存只能有一份，理由见
    // BootContext.kernelAccessors 的注释）；这里传进去，让 ModelCatalog 的 getter 读活源。
    ctx.surfaces = buildKernelSurfaces(ctx.kernelRegistry!, ctx.kernelAccessors!);
  },
};

export default step;
