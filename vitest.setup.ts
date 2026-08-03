// Vitest setup:给 jsdom 环境里缺失的 window.pi 一个空桥接面。
// 各 store 模块顶层只是定义而不调用 window.pi,但 eventBus/general-config
// 在 import 链上可能触达——空 stub 保证模块加载不炸,纯函数测试不受影响。
if (typeof window !== "undefined" && !(window as any).pi) {
  (window as any).pi = new Proxy({}, { get: () => new Proxy({}, { get: () => () => Promise.resolve(null) }) });
}
