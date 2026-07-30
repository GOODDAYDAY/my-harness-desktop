import { createContext, useContext } from "react";

export const PluginIdContext = createContext<string>("");

export function usePluginId(): string {
  return useContext(PluginIdContext);
}
