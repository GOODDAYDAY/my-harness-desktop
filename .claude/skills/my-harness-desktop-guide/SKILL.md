---
name: my-harness-desktop-guide
description: my-harness-desktop 桌面端的体系速查与排障指南。当用户在 my-harness-desktop 里询问这个应用本身的功能、配置位置、插件体系、skills 管理,或遇到桌面端行为疑问时使用。
---

# my-harness-desktop 速查

my-harness-desktop 是 pi 底座的 Electron 桌面壳:薄内核(加载器/槽位/权限/RPC) + 插件内容层。
本 skill 只覆盖"这个桌面应用本身"的事实,不覆盖 pi 底座的通用用法。

## 配置与数据位置

- 桌面配置区:`~/.my-harness-desktop/`(config/ 偏好与插件配置、plugins/ 用户级插件、skills/ 内置 skills 受管目录)
- 底座配置:`~/.pi/agent/settings.json`(models、skills[] 等底座字段)
- 桌面偏好(主题/字号/语言):electron-store,存于 `~/.my-harness-desktop/config/`

## skills 管理

- 设置页 → Skills:列出全部来源的 skill,支持启用/禁用、固定到上下文、路径来源增删。
- 启用/禁用:写 settings.json `skills[]` 的 `+/-` 模式条目(`-` 优先级最高)。
- 固定到上下文:改写 SKILL.md frontmatter 的 `disable-model-invocation`(false = 进 system prompt 模型可自动调用)。
- 内置 skills:`~/.my-harness-desktop/skills/`,随 app 升级强制覆盖(受管目录,要改请 fork 到自己的 skills 目录);总开关挂/摘 settings.json 里的源路径条目。
- 一切变更下次新会话生效;当前会话要立即生效需在 pi 终端跑 `/reload`。

## 插件体系速记

- 槽位:sidebar / sidePanel / mainView / titlebar / settings / themes / languages / messageRenderers / fileActions。
- 插件三接入点:plugin.json(声明)、renderer/index.tsx(呈现)、PluginContext(能力+事件)。
- 插件间通信只走 `ctx.events.emit/on/invoke`,不走共享 store 互写。
