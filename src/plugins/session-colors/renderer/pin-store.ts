import { create } from "zustand";

export interface Pin {
  id: string;
  color: string;
  x: number;
  y: number;
}

export const PALETTE = [
  "#f38ba8", "#fab387", "#f9e2af", "#a6e3a1",
  "#89b4fa", "#cba6f7", "#f5c2e7",
];

interface PinStoreState {
  selectedColor: string | null;
  pins: Record<string, Pin[]>;
  pinMode: boolean;
  loaded: boolean;
  setPins: (pins: Record<string, Pin[]>) => void;
  selectColor: (color: string | null) => void;
  setPinMode: (on: boolean) => void;
  addPin: (sessionPath: string, pin: Pin) => void;
  removePin: (sessionPath: string, pinId: string) => void;
  setLoaded: (loaded: boolean) => void;
}

export const usePinStore = create<PinStoreState>((set) => ({
  selectedColor: null,
  pins: {},
  pinMode: false,
  loaded: false,
  setPins: (pins) => set({ pins }),
  selectColor: (color) => set({ selectedColor: color, pinMode: color !== null }),
  setPinMode: (on) => set({ pinMode: on, selectedColor: on ? null : null }),
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
