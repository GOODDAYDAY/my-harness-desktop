// font-presets renderer 入口:纯字体 @font-face 副作用,无组件、无 channels。
// 框架 plugins-host 的 import.meta.glob(../../plugins/*/*/renderer/index.{ts,tsx})
// 按目录约定加载本模块;字体经 Vite 打进 out/renderer/assets,由 HTTP 服务供出
// (.otf MIME 见 transport/http/http-server.ts)。字体栈数据仍在 manifest(§2.2
// 内容外推),这里只承担「把打包字体注册进 CSS 引擎」的机制。
import "./serious-shanns.css";
