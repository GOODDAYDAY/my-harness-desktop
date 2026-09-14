// electron-vite 构建配置(web-service §21):main 双入口(electron 宿主 + server 宿主)+ renderer。
//   electron 宿主: src/server/bootstrap/electron.ts → out/main/index.js(electron .)
//   server 宿主:  src/server/bootstrap/server.ts  → out/main/server.js(node out/main/server.js)
//   renderer:    src/web/index.html(由后端 HTTP 服务)
import { defineConfig } from "electron-vite";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

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
          // 内核插件工厂独立打包(物理插件:动态 require 的 plugin.js;入口名对齐运行时扫描路径)。
          "server/kernel/pi/plugin": resolve(__dirname, "src/server/kernel/pi/plugin.ts"),
          "server/kernel/dsh/plugin": resolve(__dirname, "src/server/kernel/dsh/plugin.ts"),
          "server/kernel/minimal/plugin": resolve(__dirname, "src/server/kernel/minimal/plugin.ts"),
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
