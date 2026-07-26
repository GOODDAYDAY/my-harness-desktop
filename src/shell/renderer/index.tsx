// renderer React 入口
// 当前是白屏骨架：挂一个空 #root。后续槽位渲染、pi.ui 组件库、插件 portal 在此接入。
import { createRoot } from "react-dom/client";

const rootEl = document.getElementById("root");
if (rootEl) {
  createRoot(rootEl).render(null);
}
