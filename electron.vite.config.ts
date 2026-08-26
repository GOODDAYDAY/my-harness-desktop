// electron-vite 构建配置(web-service §21):main 双入口(electron 宿主 + server 宿主)+ renderer。
//   electron 宿主: src/bootstrap/electron.ts → out/main/index.js(electron .)
//   server 宿主:  src/bootstrap/server.ts  → out/main/server.js(node out/main/server.js)
//   renderer:    src/api/renderer/index.html(由后端 HTTP 服务)
import { defineConfig } from "electron-vite";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/bootstrap/electron.ts"),
          server: resolve(__dirname, "src/bootstrap/server.ts"),
        },
        output: { format: "cjs", entryFileNames: "[name].js" },
        external: ["tar"],
      },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/api/renderer"),
    resolve: {
      alias: {
        "@": resolve(__dirname, "src"),
        // workspace 发布面直读源码(对齐 tsconfig paths):build 不依赖 node_modules 的 workspace link,
        // 也绕开 rollup 不 transform node_modules 内 .ts 的问题(main 指向 src/index.ts)。
        "@my-harness-desktop/react": resolve(__dirname, "packages/react/src/index.ts"),
        "@my-harness-desktop/contract": resolve(__dirname, "packages/contract/src/index.ts"),
      },
    },
    build: {
      rollupOptions: {
        input: resolve(__dirname, "src/api/renderer/index.html"),
      },
    },
    plugins: [react(), tailwindcss()],
  },
});
