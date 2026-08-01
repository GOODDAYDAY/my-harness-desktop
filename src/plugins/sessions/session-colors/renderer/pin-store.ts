import { create } from "zustand";
import type { Pin } from "../core/pin";

interface PinStoreState {
  selectedColor: string | null;
  pins: Record<string, Pin[]>;
  pinMode: boolean;
  pinsVisible: boolean;
  loaded: boolean;
  setPins: (pins: Record<string, Pin[]>) => void;
  selectColor: (color: string | null) => void;
  togglePinsVisible: () => void;
  addPin: (sessionPath: string, pin: Pin) => void;
  removePin: (sessionPath: string, pinId: string) => void;
  setLoaded: (loaded: boolean) => void;
}

export const usePinStore = create<PinStoreState>((set) => ({
  selectedColor: null,
  pins: {},
  pinMode: false,
  pinsVisible: true,
  loaded: false,
  setPins: (pins) => set({ pins }),
  selectColor: (color) => set({ selectedColor: color, pinMode: color !== null }),
  togglePinsVisible: () => set((s) => ({ pinsVisible: !s.pinsVisible })),
  addPin: (sessionPath, pin) =>
    set((s) => {
      const existing = s.pins[sessionPath] ?? [];
      const filtered = existing.filter((p) => p.color !== pin.color);
      return { pins: { ...s.pins, [sessionPath]: [...filtered, pin] } };
    }),
  removePin: (sessionPath, pinId) =>
    set((s) => {
      const existing = s.pins[sessionPath] ?? [];
      const filtered = existing.filter((p) => p.id !== pinId);
      const next = { ...s.pins };
      if (filtered.length === 0) delete next[sessionPath];
      else next[sessionPath] = filtered;
      return { pins: next };
    }),
  setLoaded: (loaded) => set({ loaded }),
}));
