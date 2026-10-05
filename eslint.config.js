import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // dsh 内核插件(.mjs)跑在 dsh 进程(node 环境),用 console/process 等 node 全局是合法的,
    // 不受壳插件 TS 的 lint 规则约束;与 .js 同批忽略。
    ignores: ["src/plugins/**/*.{js,mjs}"],
  },
  {
    files: ["src/plugins/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      // 注册了规则,插件里 eslint-disable-next-line react-hooks/* 才生效(此前报 rule-not-found)
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      // 下划线前缀 = 有意不用。默认配置不认这个约定,于是测试里的占位形参
      // (`useDebouncedValue: (_v, _ms) => ...` 这类 mock 签名对齐) 会判成 unused-vars —— 
      // 实测 `npm run lint` 因此长期 10 error 全红,红着的门等于没有门。
      // 按社区标准约定显式放行下划线前缀(只放行前缀,不是整体关掉规则)。
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "MemberExpression[object.name='window'][property.name='pi']",
          message: "禁止直接访问 window.pi，使用 usePluginContext() 拿受控 API",
        },
        {
          selector: "VariableDeclarator[id.name='PLUGIN_ID']",
          message: "禁止手写 PLUGIN_ID 常量，pluginId 由 PluginIdContext 自动注入",
        },
        {
          selector: "CallExpression[callee.name='usePiApi']",
          message: "usePiApi 已废弃，使用 usePluginContext()",
        },
        {
          selector: "CallExpression[callee.name=/^register.*Component$/]",
          message: "组件注册由框架从 manifest 自动关联，插件只 export 组件",
        },
      ],
    },
  },
  // ⇐ 此处曾有第三块:files 指 `src/shell/electron-main/**` + `src/shell/ipc-channels.ts` 的
  // 三条 no-restricted-syntax(IPC 通道字面量拦截)。files 指向的 src/shell/ 目录**不存在**,
  // 规则从未匹配任何文件——静默失效被文档审计照出(docs/reports/doc-code-gap-audit §3#3,
  // 2026-10),整块删除而非迁移:前后端分离后 ipcMain/ipcRenderer 调用形态已不存在
  // (通道注册是 gateway.register),通道名单源由 tsc(IPC 类型)+ ipc-channel-single-source
  // 测试守,这三条字面量 lint 失去了拦截对象。
);
