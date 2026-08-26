// 内置 skills 同步 —— application/skills/bundled-skills。
//
// 镜像原语收敛到 bundled/mirror(内置 skills 与内置表情包共用),此处 re-export 保持
// mirrorBundledSkills 名字对外不变(bootstrap 与既有调用点零改动)。
// 挂/摘 pi settings.json skills[] 的 pi 专属逻辑已下沉 client/pi(pi-bundled-skills),
// 壳不再碰 pi 存储格式。
export { mirrorManagedDir as mirrorBundledSkills } from "../bundled/mirror";
