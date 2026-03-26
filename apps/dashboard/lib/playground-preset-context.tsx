"use client";

import { createContext, useCallback, useContext, useRef, type ReactNode } from "react";

export interface PlaygroundPreset {
  modelId?: string;
  accountId?: string;
}

interface PlaygroundPresetContextValue {
  setPreset: (preset: PlaygroundPreset) => void;
  consumePreset: () => PlaygroundPreset | null;
}

const PlaygroundPresetContext = createContext<PlaygroundPresetContextValue | null>(null);

export function PlaygroundPresetProvider({ children }: { children: ReactNode }) {
  const presetRef = useRef<PlaygroundPreset | null>(null);

  const setPreset = useCallback((preset: PlaygroundPreset) => {
    presetRef.current = preset;
  }, []);

  const consumePreset = useCallback((): PlaygroundPreset | null => {
    const preset = presetRef.current;
    presetRef.current = null;
    return preset;
  }, []);

  return (
    <PlaygroundPresetContext.Provider value={{ setPreset, consumePreset }}>
      {children}
    </PlaygroundPresetContext.Provider>
  );
}

export function usePlaygroundPreset() {
  const ctx = useContext(PlaygroundPresetContext);
  if (!ctx) {
    throw new Error("usePlaygroundPreset must be used within PlaygroundPresetProvider");
  }
  return ctx;
}
