// electron-vite 构建配置(web-service §21):main 双入口(electron 宿主 + server 宿主)+ renderer。
//   electron 宿主: src/server/bootstrap/electron.ts → out/main/index.js(electron .)
//   server 宿主:  src/server/bootstrap/server.ts  → out/main/server.js(node out/main/server.js)
//   renderer:    src/web/index.html(由后端 HTTP 服务)
import { defineConfig } from "electron-vite";
import { resolve, join } from "node:path";
import { readdirSync, existsSync } from "node:fs";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/** 内核工厂产物的 rollup input 表 —— 按**内容判据**生成，不手写清单。
 *
 *  判据：`src/server/kernel/` 的一级子目录里**含 `plugin.ts` 的才是内核**。
 *  这条判据是运行期 `resolveKernelFactoryPath`（`kernel-plugin-loader.ts:97-101`，按
 *  `<构建根>/<id>/plugin.js` 定位）的构建期镜像——两侧同源，不会漂。
 *
 *  为什么不能用「平铺扫 .ts」：`src/server/kernel/` 顶层是四个目录（`core` / `dsh` /
 *  `minimal` / `pi`）加一个 `seed-transcription.test.ts`，平铺生成器
 *  过滤后返回**空对象**，三个内核工厂产物全部消失，运行时 `loadKernelPlugin` 抛
 *  「工厂产物不存在」。
 *  为什么也不能「把递归做成参数」：`src/server/kernel/` 下有 72 个非测试 `.ts`
 *  （`core/` 的机制、`pi/backend/`、`pi/protocol/` 等），全量递归会把它们都变成独立 input，
 *  产物目录膨胀二十多倍且大部分永不被 require。
 *
 *  收益：加第四个内核 = 加一个目录（含 `plugin.ts`），本文件零改动
 *  （依据 docs/design/boot-surface.md §3.4.1、目标「考虑加入第四个内核的可能性」）。 */
const kernelPluginInputs = (srcDir: string, outPrefix: string): Record<string, string> => {
  const root = resolve(__dirname, srcDir);
  if (!existsSync(root)) return {};
  return Object.fromEntries(
    readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(root, d.name, "plugin.ts")))
      .map((d) => [`${outPrefix}/${d.name}/plugin`, join(root, d.name, "plugin.ts")]),
  );
};

/** 启动步骤产物的 rollup input 表 —— **平铺**扫一个目录里的 `.ts`，一个文件一个 input。
 *
 *  与 `kernelPluginInputs` 的区别是判据形状：内核用「子目录含 plugin.ts」（内容判据），
 *  步骤用「目录里的每个 .ts 就是一个步骤」（平铺判据）。后者成立的前提是
 *  **`steps/` 目录里只放步骤文件**（共享 helper 放父目录 `bootstrap/boot/`），
 *  这条约束由 `scanBootSteps` 的「缺 default 导出即抛」在运行期兜住（boot/scan.ts）。
 *
 *  为什么必须一个 step 一个 input：运行时是**真扫描** `out/main/boot/steps/` 目录
 *  （与内核插件工厂同一套机制）。若不单独成入口，它们会被 bundle 进 `assemble` 所在的 chunk，
 *  那个目录根本不存在 → `scanBootSteps` 返回空 → `buildBootPlan` 抛
 *  「启动步骤目录为空或不可读」。这是 docs/design/boot-surface.md §3.4.1 记的第一笔代价。
 *
 *  排除 `.test.ts`：测试与步骤同目录时不该产出步骤产物。
 *  目录不存在时返回空对象（阶段一交付步骤文件之前，本配置已可安全合入）。 */
const flatInputs = (srcDir: string, outPrefix: string): Record<string, string> => {
  const root = resolve(__dirname, srcDir);
  if (!existsSync(root)) return {};
  return Object.fromEntries(
    readdirSync(root)
      .filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts"))
      .map((n) => [`${outPrefix}/${n.replace(/\.ts$/, "")}`, join(root, n)]),
  );
};

// 内核 manifest 不再需要单独复制：内核插件与壳插件**共用同一份 plugin.json**，
// 它住在 src/plugins/kernels/<id>/（测试专用内核插件住 test-plugins/kernels/<id>/，**不随壳分发**），随内置插件目录一起分发（dev 直接读源码树，
// 打包由 electron-builder 的 extraResources 拷进 resources/my-harness-desktop-builtin/）。
// 这里只需保证各内核的**工厂产物**被编译到约定的构建根 out/main/server/kernel/<id>/plugin.js。

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/server/bootstrap/electron.ts"),
          server: resolve(__dirname, "src/server/bootstrap/server.ts"),
          preload: resolve(__dirname, "src/server/preload.ts"),
          // 内核插件工厂独立打包（物理插件：动态 require 的 plugin.js；入口名对齐运行时扫描路径）。
          // 由 kernelPluginInputs 按内容判据生成——加内核不需要改本文件。
          ...kernelPluginInputs("src/server/kernel", "server/kernel"),
          // 启动步骤（boot/steps/*.ts → out/main/boot/steps/*.js），由 boot/scan.ts 真扫描装载。
          ...flatInputs("src/server/bootstrap/boot/steps", "boot/steps"),
        },
        output: { format: "cjs", entryFileNames: "[name].js" },
        external: ["tar"],
      },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/web"),
    resolve: {
      alias: {
        "@": resolve(__dirname, "src"),
        // workspace 发布面直读源码(对齐 tsconfig paths):build 不依赖 node_modules 的 workspace link,
        // 也绕开 rollup 不 transform node_modules 内 .ts 的问题(main 指向 src/index.ts)。
        "@my-harness-desktop/react": resolve(__dirname, "packages/react/src/index.ts"),
        "@my-harness-desktop/shared": resolve(__dirname, "packages/shared/src/index.ts"),
      },
    },
    server: {
      // 开发态(§21.4):renderer 由 Vite 起(ELECTRON_RENDERER_URL),但 WS /rpc 在后端(127.0.0.1:8420)。
      // 前端 index.tsx 连 ws://<location.host>/rpc = Vite,此处把 /rpc(WS)反代到后端,单一传输不断。
      // 登录门同源:入口先查 /auth-state、登录走 /login,同样反代到后端——否则开发态
      // 页面挂在 Vite 域上,两路由 404,引导被「auth-state 不可用」错误态卡死。
      proxy: {
        "/rpc": {
          target: "http://127.0.0.1:8420",
          ws: true,
        },
        // 精确匹配(勿用字符串前缀:字符串 "/login" 会把源码模块 /login-gate.ts 也劫持走,
        // 模块请求被反代到后端拿回 HTML,引导期 "Expected a JavaScript module... text/html")。
        "^/auth-state$": {
          target: "http://127.0.0.1:8420",
        },
        "^/login$": {
          target: "http://127.0.0.1:8420",
        },
      },
    },
    build: {
      rollupOptions: {
        input: resolve(__dirname, "src/web/index.html"),
      },
    },
    plugins: [react(), tailwindcss()],
  },
});
