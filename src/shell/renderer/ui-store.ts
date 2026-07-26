// shell 侧 re-export @pi-desktop/react 的 ui-store(真相源在包里,守薄壳:plugins 不直连 shell)。
// shell 内部(theme-context、index.tsx 等)经此 import,实际实现来自 @pi-desktop/react。
export {
  useUiStore,
  type MainView,
  type FontMonoChoice,
  type FontSansTone,
  type UiState,
} from "@pi-desktop/react";
