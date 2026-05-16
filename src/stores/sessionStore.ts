"use client";

import { create } from "zustand";

import type { AppStatus, TranslationSegment } from "@/types";

const MAX_SEGMENTS = 200;

type PerformanceMemoryShape = { usedJSHeapSize?: number };

function logMemoryIfMilestone(count: number) {
  if (count === 0 || count % 50 !== 0) return;
  const mem = (performance as unknown as { memory?: PerformanceMemoryShape })
    .memory;
  if (mem?.usedJSHeapSize) {
    const mb = Math.round(mem.usedJSHeapSize / 1024 / 1024);
    console.log(`[LINGO] Memory: ${mb}MB at ${count} segments`);
  }
}

export interface LingoStore {
  isListening: boolean;
  sessionStartTime: number | null;

  segments: TranslationSegment[];

  status: AppStatus;
  error: string | null;

  // Translation pipeline state
  isProcessingChunk: boolean;
  slowChunkProcessing: boolean;
  chunkQueue: Blob[];

  // Resilience state
  warningBannerVisible: boolean;
  isOnline: boolean;
  slowConnection: boolean;

  startListening: () => Promise<void>;
  stopListening: () => void;
  addSegment: (segment: TranslationSegment) => void;
  clearSession: () => void;
  setStatus: (s: AppStatus) => void;
  setError: (message: string | null) => void;
  setIsProcessingChunk: (v: boolean) => void;
  setSlowChunkProcessing: (v: boolean) => void;
  enqueueChunk: (blob: Blob) => void;
  drainChunkQueue: () => Blob[];
  setWarningBannerVisible: (v: boolean) => void;
  setOnline: (v: boolean) => void;
  setSlowConnection: (v: boolean) => void;
}

export const useSessionStore = create<LingoStore>((set, get) => ({
  isListening: false,
  sessionStartTime: null,

  segments: [],

  status: "idle",
  error: null,

  isProcessingChunk: false,
  slowChunkProcessing: false,
  chunkQueue: [],

  warningBannerVisible: false,
  isOnline: true,
  slowConnection: false,

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

  addSegment: (segment) =>
    set((state) => {
      const next = [...state.segments, segment];
      let segments = next;
      if (next.length > MAX_SEGMENTS) {
        const trim = next.length - MAX_SEGMENTS;
        console.log(
          `[LINGO] Segment cap reached — removing ${trim} oldest segment(s)`,
        );
        segments = next.slice(trim);
      }
      logMemoryIfMilestone(segments.length);
      return { segments };
    }),

  clearSession: () =>
    set({
      isListening: false,
      sessionStartTime: null,
      segments: [],
      status: "idle",
      error: null,
      isProcessingChunk: false,
      slowChunkProcessing: false,
      chunkQueue: [],
      warningBannerVisible: false,
      slowConnection: false,
    }),

  setStatus: (s) => set({ status: s }),

  setError: (message) =>
    set({
      error: message,
      status: message ? "error" : "idle",
    }),

  setIsProcessingChunk: (v) => set({ isProcessingChunk: v }),
  setSlowChunkProcessing: (v) => set({ slowChunkProcessing: v }),

  enqueueChunk: (blob) =>
    set((state) => ({ chunkQueue: [...state.chunkQueue, blob] })),

  drainChunkQueue: () => {
    const queue = get().chunkQueue;
    if (queue.length === 0) return [];
    set({ chunkQueue: [] });
    return queue;
  },

  setWarningBannerVisible: (v) => set({ warningBannerVisible: v }),
  setOnline: (v) => set({ isOnline: v }),
  setSlowConnection: (v) => set({ slowConnection: v }),
}));

export default useSessionStore;
