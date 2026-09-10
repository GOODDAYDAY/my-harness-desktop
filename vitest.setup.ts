// Vitest setup:给 jsdom 环境补齐缺失的浏览器面。
//
// 1) window.pi 空桥接面:各 store 模块顶层只是定义而不调用 window.pi,但 eventBus/
//    general-config 在 import 链上可能触达——空 stub 保证模块加载不炸,纯函数测试不受影响。
// 2) ResizeObserver:jsdom 没有它,而左栏壳(sidebar.tsx)用它跟"内容高度/容器高度"的
//    变化(折叠联动要按实测高度算塌缩目标)。无排版环境下回调给 0 也无所谓——壳在
//    boxPx<=0 时本就不动作,正好让 jsdom 里的断言只覆盖"声明式结构",像素行为交给 e2e。
if (typeof window !== "undefined" && !(window as any).pi) {
  (window as any).pi = new Proxy({}, { get: () => new Proxy({}, { get: () => () => Promise.resolve(null) }) });
}

if (typeof globalThis.ResizeObserver === "undefined") {
  class ResizeObserverStub {
    observe(): void { /* jsdom 无排版:不产生回调 */ }
    unobserve(): void { /* 同上 */ }
    disconnect(): void { /* 同上 */ }
  }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;
}
