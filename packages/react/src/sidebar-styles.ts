export type SidebarStyle = "default" | "compact";

export interface SidebarStylePreset {
  id: SidebarStyle;
  label: string;
  vars: Record<string, string>;
}

export const SIDEBAR_STYLES: SidebarStylePreset[] = [
  {
    id: "default",
    label: "默认",
    vars: {
      "--sidebar-row-gap": "6px",
      "--sidebar-row-py": "10px",
      "--sidebar-icon-size": "14px",
      "--sidebar-icon-box": "20px",
      "--sidebar-section-fs": "12px",
      "--sidebar-section-pt": "6px",
      "--sidebar-section-pb": "6px",
      "--sidebar-arrow-display": "inline-flex",
      "--sidebar-divider-display": "flex",
    },
  },
  {
    id: "compact",
    label: "紧凑",
    vars: {
      "--sidebar-row-gap": "4px",
      "--sidebar-row-py": "10px",
      "--sidebar-icon-size": "16px",
      "--sidebar-icon-box": "28px",
      "--sidebar-section-fs": "11px",
      "--sidebar-section-pt": "16px",
      "--sidebar-section-pb": "6px",
      "--sidebar-arrow-display": "none",
      "--sidebar-divider-display": "none",
    },
  },
];

export const SIDEBAR_STYLE_MAP: Record<string, SidebarStylePreset> = Object.fromEntries(
  SIDEBAR_STYLES.map((s) => [s.id, s]),
);
