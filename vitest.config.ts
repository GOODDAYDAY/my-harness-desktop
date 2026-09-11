import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node", // 纯函数测试;store 链上 window 引用全在函数体内,setup 里补 stub
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "packages/shared/src/**/*.test.ts",
      // packages/react 也是**有真逻辑的发布面**(event-bus / PluginContext / 自动匹配),
      // 按 CLAUDE.md §5.6 纯逻辑该有 unittest、§4.5 判据(不需要 mock 外部环境)本就该测。
      // 第 222 轮实测:此前**没扫它** —— 我写的第一个 packages/react 测试**根本不会被发现**
      // (`No test files found`),即"文件存在 ≠ 会被执行"。加进来,避免再产出**永不运行的守卫**。
      "packages/react/src/**/*.test.ts",
      "packages/react/src/**/*.test.tsx"],
    setupFiles: ["./vitest.setup.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@my-harness-desktop/shared": path.resolve(__dirname, "packages/shared/src/index.ts"),
      "@my-harness-desktop/react": path.resolve(__dirname, "packages/react/src/index.ts"),
    },
  },
});
