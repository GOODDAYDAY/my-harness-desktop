// ContextMenu —— 右键菜单共享部件(radix 封装 + 主题 token 样式收敛)。
//
// 此前 sessions-list / pi-model-manager 各手滚一份菜单样式(同一逻辑多处写);
// 文件树是第三个消费方,样式在此收敛一份。旧两处不强制迁移,新代码一律用这里。
import * as ContextMenu from "@radix-ui/react-context-menu";

export function CtxMenu({ trigger, children }: {
  trigger: React.ReactNode;
  children: React.ReactNode;
}): React.ReactNode {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{trigger}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content style={menuStyle}>{children}</ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

export function CtxMenuItem({ icon, danger, disabled, onSelect, children }: {
  icon?: React.ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
  children: React.ReactNode;
}): React.ReactNode {
  return (
    <ContextMenu.Item
      disabled={disabled}
      onSelect={onSelect}
      style={{
        ...itemStyle,
        color: danger ? "var(--color-accent-danger)" : disabled ? "var(--color-muted)" : itemStyle.color,
        cursor: disabled ? "default" : itemStyle.cursor,
        opacity: disabled ? 0.5 : undefined,
      }}
    >
      {icon}
      {children}
    </ContextMenu.Item>
  );
}

export function CtxMenuSeparator(): React.ReactNode {
  return <ContextMenu.Separator style={separatorStyle} />;
}

const menuStyle: React.CSSProperties = {
  minWidth: "160px",
  background: "var(--color-surface)",
  border: "1px solid var(--color-border)",
  borderRadius: "var(--radius-sm)",
  boxShadow: "var(--shadow-md)",
  padding: "4px",
  zIndex: 99999,
};

const itemStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "8px",
  padding: "6px 10px",
  borderRadius: "var(--radius-sm)",
  fontSize: "var(--font-size-base)",
  color: "var(--color-fg)",
  cursor: "pointer",
  outline: "none",
  userSelect: "none",
};

const separatorStyle: React.CSSProperties = {
  height: "1px",
  background: "var(--color-border)",
  margin: "4px 6px",
};
