// electron-vite 三端构建配置
// 入口路径按 docs/structure/18 约定：
//   main:     src/shell/electron-main/index.ts
//   preload:  src/shell/electron-main/preload.ts
//   renderer: src/shell/renderer/index.html
import { defineConfig } from "electron-vite";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: resolve(__dirname, "src/shell/electron-main/index.ts"),
        output: { format: "cjs", entryFileNames: "[name].js" },
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: resolve(__dirname, "src/shell/electron-main/preload.ts"),
        output: { format: "cjs", entryFileNames: "[name].js" },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/shell/renderer"),
    build: {
      rollupOptions: {
        input: resolve(__dirname, "src/shell/renderer/index.html"),
      },
    },
    plugins: [react()],
  },
});
