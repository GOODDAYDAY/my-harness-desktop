import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node", // 纯函数测试;store 链上 window 引用全在函数体内,setup 里补 stub
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    setupFiles: ["./vitest.setup.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@pi-desktop/contract": path.resolve(__dirname, "packages/contract/src/index.ts"),
      "@pi-desktop/react": path.resolve(__dirname, "packages/react/src/index.ts"),
    },
  },
});
