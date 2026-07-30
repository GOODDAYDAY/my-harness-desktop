import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/plugins/**/*.{ts,tsx}"],
    rules: {
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
);
