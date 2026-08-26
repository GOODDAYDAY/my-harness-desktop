import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node", // 纯函数测试;store 链上 window 引用全在函数体内,setup 里补 stub
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "packages/shared/src/**/*.test.ts"],
    setupFiles: ["./vitest.setup.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@my-harness-desktop/contract": path.resolve(__dirname, "packages/contract/src/index.ts"),
      "@my-harness-desktop/shared": path.resolve(__dirname, "packages/shared/src/index.ts"),
      "@my-harness-desktop/react": path.resolve(__dirname, "packages/react/src/index.ts"),
    },
  },
});
