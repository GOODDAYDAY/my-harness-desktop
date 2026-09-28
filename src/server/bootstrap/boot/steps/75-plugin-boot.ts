// 步骤 75：壳插件的启动面装载（per-entity over plugins）。
//
// 收编设计文档 §1.1.2 的动作 #11（插件技能）与 #13 的前半（插件携带的内核扩展同步）。
// **与暖启动共用同一张表、同一个驱动器**：`lifecycle.activate` 调
// `runOps(PLUGIN_ATTACH_OPS, "warm", [该插件], …)`，本步骤调
// `runOps(PLUGIN_ATTACH_OPS, "cold", 全部插件, …)`。这是设计文档 §5.1 的核心——
// 两份实现合一，留痕格式与失败语义只有一份。
//
// **不需要 `disabled` 过滤**（今天 `assemble.ts:519` 有一道）：禁用插件在 `40-shell-plugins`
// 就根本没注册（§5.1.2），遍历注册表自然遇不到它。保留那道过滤是把旧实现的形状抄过来，
// 按新语义它是死代码。
import type { BootStep } from "../types";
import { runOps, PLUGIN_ATTACH_OPS, toPluginEntity } from "../../../application/lifecycle/boot-ops";
import type { PluginBootDeps } from "../../../application/lifecycle/boot-ops";

const step: BootStep = {
  id: "75-plugin-boot",
  scope: "per-entity",
  failure: "degrade",
  requires: ["40-shell-plugins", "50-wiring"],
  async run(ctx) {
    const deps = ctx.lifecycleDeps!;
    const bootDeps: PluginBootDeps = {
      skillsEnsure: deps.skillsEnsure,
      pluginExtensionEnsure: deps.pluginExtensionEnsure,
    };
    const entities = [...ctx.registry!.allPlugins().values()].map(toPluginEntity);
    await runOps(PLUGIN_ATTACH_OPS, "cold", entities, bootDeps, (e) => e.id);
  },
};

export default step;
