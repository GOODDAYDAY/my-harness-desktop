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
  {
    // IPC 通道名单源护栏(ipc-channels.ts):禁止 shell 进程桥再回到字符串字面量,
    // 拼错/双写由 tsc + 本规则双重拦截(依据 CLAUDE.md §1.3 契约单源)
    files: ["src/shell/electron-main/**/*.{ts,tsx}", "src/shell/ipc-channels.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.object.name='ipcMain'][callee.property.name='handle'] > Literal:first-child",
          message: "IPC 通道名单源收敛于 ../ipc-channels.ts,请用 IPC.* 常量,禁写字符串字面量",
        },
        {
          selector: "CallExpression[callee.object.name='ipcRenderer'][callee.property.name=/^(invoke|on|once|removeListener)$/] > Literal:first-child",
          message: "IPC 通道名单源收敛于 ../ipc-channels.ts,请用 IPC.* 常量,禁写字符串字面量",
        },
        {
          selector: "CallExpression[callee.object.property.name='webContents'][callee.property.name='send'] > Literal:first-child",
          message: "push 通道名单源收敛于 ../ipc-channels.ts,请用 IPC.* 常量,禁写字符串字面量",
        },
      ],
    },
  },
);
