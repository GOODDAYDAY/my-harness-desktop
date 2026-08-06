export interface Pin {
  id: string;
  color: string;
  x: number;
  y: number;
}

/** 内容钉(钉会话流消息,docs/design/content-pins.md):锚点 = messageId(JSONL 行级 id),
 *  x/y 相对消息元素([data-message-id])渲染框的百分比。Pin 是会话行钉,两者同族不同挂载面。 */
export interface ContentPin {
  id: string;
  messageId: string;
  color: string;
  x: number;
  y: number;
}

export const CONTENT_PIN_DEFAULT = { x: 97, y: 6 };

export const PALETTE = [
  "#f38ba8", "#fab387", "#f9e2af", "#a6e3a1",
  "#89b4fa", "#cba6f7", "#f5c2e7",
];
