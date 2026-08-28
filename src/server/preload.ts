// preload —— Electron 桌面独有:向 renderer 暴露拖拽/粘贴文件的绝对路径解析。
//
// web 服务化后 renderer 是纯 web 页(无 node 集成),标准 File 对象不携带路径;
// webUtils.getPathForFile 是 Electron 拿拖拽/粘贴文件绝对路径的唯一 API,且只能在
// preload(renderer 进程侧,能拿到 File 对象)调用。远程浏览器无 preload → window.mhdFile
// 缺失,消费方(timeline)据此显式降级(用文件名代替绝对路径)。
import { contextBridge, webUtils } from "electron";

contextBridge.exposeInMainWorld("mhdFile", {
  /** 解析拖拽/粘贴 File 的绝对路径;解析失败(远程/非磁盘文件)返回空串。 */
  getPathForFile(file: File): string {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },
});
