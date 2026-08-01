// electron-vite 三端构建配置
// 入口路径:
//   main:     src/bootstrap/index.ts
//   preload:  src/api/preload/preload.ts
//   renderer: src/api/renderer/index.html
import { defineConfig } from "electron-vite";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: resolve(__dirname, "src/bootstrap/index.ts"),
        output: { format: "cjs", entryFileNames: "[name].js" },
        external: ["tar"],
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: resolve(__dirname, "src/api/preload/preload.ts"),
        output: { format: "cjs", entryFileNames: "[name].js" },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/api/renderer"),
    resolve: {
      alias: {
        "@": resolve(__dirname, "src"),
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
