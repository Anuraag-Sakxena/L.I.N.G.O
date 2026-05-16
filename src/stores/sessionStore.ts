"use client";

import { create } from "zustand";

import type {
  AppStatus,
  AssameseSegment,
  EnglishTranslation,
} from "@/types";

const MAX_SEGMENTS = 200;

type PerformanceMemoryShape = { usedJSHeapSize?: number };

function logMemoryIfMilestone(count: number) {
  if (count === 0 || count % 50 !== 0) return;
  const mem = (performance as unknown as { memory?: PerformanceMemoryShape })
    .memory;
  if (mem?.usedJSHeapSize) {
    const mb = Math.round(mem.usedJSHeapSize / 1024 / 1024);
    console.log(`[LINGO] Memory: ${mb}MB at ${count} Assamese segments`);
  }
}

export interface LingoStore {
  isListening: boolean;
  sessionStartTime: number | null;

  // Dual-list translation model:
  // - assameseSegments: ordered append-only (lands when Scribe commits).
  // - englishTranslations: keyed by Assamese id (lands when Claude returns,
  //   possibly out of order).
  // - pendingTranslationIds: ids currently in-flight at Claude. Drives the
  //   "Translating…" indicator.
  assameseSegments: AssameseSegment[];
  englishTranslations: Record<string, EnglishTranslation>;
  pendingTranslationIds: Set<string>;

  status: AppStatus;
  error: string | null;

  isOnline: boolean;
  slowConnection: boolean;
  warningBannerVisible: boolean;

  startListening: () => Promise<void>;
  stopListening: () => void;
  addAssameseSegment: (seg: AssameseSegment) => void;
  addEnglishTranslation: (trans: EnglishTranslation) => void;
  addPendingTranslation: (id: string) => void;
  removePendingTranslation: (id: string) => void;
  clearSession: () => void;
  setStatus: (s: AppStatus) => void;
  setError: (message: string | null) => void;
  setOnline: (v: boolean) => void;
  setSlowConnection: (v: boolean) => void;
  setWarningBannerVisible: (v: boolean) => void;
}

export const useSessionStore = create<LingoStore>((set) => ({
  isListening: false,
  sessionStartTime: null,

  assameseSegments: [],
  englishTranslations: {},
  pendingTranslationIds: new Set<string>(),

  status: "idle",
  error: null,

  isOnline: true,
  slowConnection: false,
  warningBannerVisible: false,

  startListening: async () => {
    set({
      isListening: true,
      sessionStartTime: Date.now(),
      status: "listening",
      error: null,
    });
  },

  stopListening: () => {
    set({
      isListening: false,
      status: "idle",
    });
  },

  addAssameseSegment: (segment) =>
    set((state) => {
      const next = [...state.assameseSegments, segment];
      let segments = next;
      if (next.length > MAX_SEGMENTS) {
        const trim = next.length - MAX_SEGMENTS;
        console.log(
          `[LINGO] Assamese cap reached — removing ${trim} oldest segment(s)`,
        );
        segments = next.slice(trim);
        // GC the corresponding English entries.
        const dropped = next.slice(0, trim);
        const englishTranslations = { ...state.englishTranslations };
        for (const s of dropped) delete englishTranslations[s.id];
        logMemoryIfMilestone(segments.length);
        return { assameseSegments: segments, englishTranslations };
      }
      logMemoryIfMilestone(segments.length);
      return { assameseSegments: segments };
    }),

  addEnglishTranslation: (translation) =>
    set((state) => ({
      englishTranslations: {
        ...state.englishTranslations,
        [translation.id]: translation,
      },
    })),

  addPendingTranslation: (id) =>
    set((state) => {
      if (state.pendingTranslationIds.has(id)) return {};
      const next = new Set(state.pendingTranslationIds);
      next.add(id);
      return { pendingTranslationIds: next };
    }),

  removePendingTranslation: (id) =>
    set((state) => {
      if (!state.pendingTranslationIds.has(id)) return {};
      const next = new Set(state.pendingTranslationIds);
      next.delete(id);
      return { pendingTranslationIds: next };
    }),

  clearSession: () =>
    set({
      isListening: false,
      sessionStartTime: null,
      assameseSegments: [],
      englishTranslations: {},
      pendingTranslationIds: new Set<string>(),
      status: "idle",
      error: null,
      slowConnection: false,
      warningBannerVisible: false,
    }),

  setStatus: (s) => set({ status: s }),

  setError: (message) =>
    set({
      error: message,
      status: message ? "error" : "idle",
    }),

  setOnline: (v) => set({ isOnline: v }),
  setSlowConnection: (v) => set({ slowConnection: v }),
  setWarningBannerVisible: (v) => set({ warningBannerVisible: v }),
}));

export default useSessionStore;
