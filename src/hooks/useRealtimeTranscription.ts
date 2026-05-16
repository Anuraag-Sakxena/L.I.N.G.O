"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { translateWithClaude } from "@/services/claude";
import { ScribeRealtimeConnection } from "@/services/elevenlabs";
import { useSessionStore } from "@/stores/sessionStore";
import type { TranslationSegment } from "@/types";

const CLAUDE_TIMEOUT_MS = 15_000;
const SLOW_API_THRESHOLD_MS = 5_000;
const SLOW_CHUNK_DELAY_MS = 5_000;
const FAILURES_FOR_WARNING = 3;
const WARNING_AUTO_DISMISS_MS = 10_000;
const REPETITION_WINDOW = 3;
const REPETITION_HITS = 2;

// Scribe sometimes still hallucinates English residue on silence. Same
// patterns as before — applied to the committed Assamese transcript.
const HALLUCINATION_PATTERNS: ReadonlyArray<RegExp> = [
  /^[\s.…]+$/,
  /^(thank you|thanks for watching|thanks for listening)/i,
  /^(please subscribe|like and subscribe)/i,
  /^(music|applause|laughter|silence|\[.*\]|\(.*\))/i,
  /^(you|i|the|a|an|um|uh|hmm)\s*[.!?]?\s*$/i,
  /^.{1,2}$/,
];

function isHallucination(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  return HALLUCINATION_PATTERNS.some((p) => p.test(t));
}

function isRepetition(
  text: string,
  recent: ReadonlyArray<TranslationSegment>,
): boolean {
  const normalized = text.toLowerCase().trim();
  if (!normalized) return false;
  const window = recent.slice(-REPETITION_WINDOW);
  const hits = window.filter(
    (s) => s.englishText.toLowerCase().trim() === normalized,
  ).length;
  return hits >= REPETITION_HITS;
}

function makeSegmentId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function describeError(err: unknown): string {
  if (err instanceof DOMException && err.name === "AbortError") return "timed out";
  return err instanceof Error ? err.message : String(err);
}

export interface UseRealtimeTranscriptionResult {
  isConnected: boolean;
  /** Live partial transcript text — updates as the user speaks. */
  partialTranscript: string;
  connect: () => void;
  disconnect: () => void;
  /** Send a base64 PCM frame to the open WebSocket. Safe to call any time. */
  sendAudio: (pcmBase64: string) => void;
}

export function useRealtimeTranscription(): UseRealtimeTranscriptionResult {
  const [isConnected, setIsConnected] = useState(false);
  const [partialTranscript, setPartialTranscript] = useState("");

  const connectionRef = useRef<ScribeRealtimeConnection | null>(null);
  const isMountedRef = useRef(true);

  // Claude resilience (carried over from the old useTranslation)
  const controllersRef = useRef<Set<AbortController>>(new Set());
  const consecutiveFailuresRef = useRef(0);
  const apiDurationsRef = useRef<number[]>([]);
  const warningTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const slowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inflightClaudeCountRef = useRef(0);

  const addSegment = useSessionStore((s) => s.addSegment);
  const setStatus = useSessionStore((s) => s.setStatus);
  const setError = useSessionStore((s) => s.setError);
  const setIsProcessingChunk = useSessionStore((s) => s.setIsProcessingChunk);
  const setSlowChunkProcessing = useSessionStore(
    (s) => s.setSlowChunkProcessing,
  );
  const setWarningBannerVisible = useSessionStore(
    (s) => s.setWarningBannerVisible,
  );
  const setSlowConnection = useSessionStore((s) => s.setSlowConnection);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      for (const c of controllersRef.current) {
        try {
          c.abort();
        } catch {
          /* ignore */
        }
      }
      controllersRef.current.clear();
      if (warningTimerRef.current) clearTimeout(warningTimerRef.current);
      if (slowTimerRef.current) clearTimeout(slowTimerRef.current);
      connectionRef.current?.disconnect();
      connectionRef.current = null;
    };
  }, []);

  const recordApiDuration = useCallback(
    (ms: number) => {
      const arr = apiDurationsRef.current;
      arr.push(ms);
      if (arr.length > 3) arr.shift();
      const slow =
        arr.length === 3 && arr.every((d) => d > SLOW_API_THRESHOLD_MS);
      setSlowConnection(slow);
    },
    [setSlowConnection],
  );

  const onPipelineFailure = useCallback(() => {
    consecutiveFailuresRef.current += 1;
    if (consecutiveFailuresRef.current >= FAILURES_FOR_WARNING) {
      setWarningBannerVisible(true);
      if (warningTimerRef.current) clearTimeout(warningTimerRef.current);
      warningTimerRef.current = setTimeout(() => {
        setWarningBannerVisible(false);
      }, WARNING_AUTO_DISMISS_MS);
    }
  }, [setWarningBannerVisible]);

  const onPipelineSuccess = useCallback(() => {
    consecutiveFailuresRef.current = 0;
    setWarningBannerVisible(false);
    if (warningTimerRef.current) {
      clearTimeout(warningTimerRef.current);
      warningTimerRef.current = null;
    }
  }, [setWarningBannerVisible]);

  const markClaudeBusy = useCallback(() => {
    inflightClaudeCountRef.current += 1;
    setIsProcessingChunk(true);
    setStatus("translating");
    if (slowTimerRef.current) clearTimeout(slowTimerRef.current);
    slowTimerRef.current = setTimeout(() => {
      setSlowChunkProcessing(true);
    }, SLOW_CHUNK_DELAY_MS);
  }, [setIsProcessingChunk, setSlowChunkProcessing, setStatus]);

  const markClaudeIdle = useCallback(() => {
    inflightClaudeCountRef.current = Math.max(
      0,
      inflightClaudeCountRef.current - 1,
    );
    if (inflightClaudeCountRef.current === 0) {
      if (slowTimerRef.current) {
        clearTimeout(slowTimerRef.current);
        slowTimerRef.current = null;
      }
      setSlowChunkProcessing(false);
      setIsProcessingChunk(false);
      const st = useSessionStore.getState();
      if (st.status === "translating") {
        st.setStatus(st.isListening ? "listening" : "idle");
      }
    }
  }, [setIsProcessingChunk, setSlowChunkProcessing]);

  // Translate a committed Assamese segment with Claude, then write to store.
  const handleCommitted = useCallback(
    async (assameseText: string) => {
      if (!isMountedRef.current) return;

      if (isHallucination(assameseText)) {
        console.log(
          `[LINGO] Hallucination detected: "${assameseText}" — skipping`,
        );
        return;
      }

      markClaudeBusy();

      const controller = new AbortController();
      controllersRef.current.add(controller);
      const timer = setTimeout(() => controller.abort(), CLAUDE_TIMEOUT_MS);
      const startMs = Date.now();

      let englishText = "";
      try {
        const claudeOut = await translateWithClaude(
          assameseText,
          controller.signal,
        );
        englishText = claudeOut.trim();
        console.log(`[LINGO] Claude translate → "${englishText}"`);
      } catch (err) {
        console.error(
          `[LINGO] Claude translate failed (${describeError(err)})`,
        );
        onPipelineFailure();
        return;
      } finally {
        clearTimeout(timer);
        controllersRef.current.delete(controller);
        recordApiDuration(Date.now() - startMs);
        markClaudeIdle();
      }

      if (!englishText || englishText.length < 2) {
        console.log("[LINGO] Claude returned empty — skipping");
        return;
      }

      if (isRepetition(englishText, useSessionStore.getState().segments)) {
        console.log(
          `[LINGO] Repetition detected — "${englishText}" appeared in recent segments, skipping`,
        );
        return;
      }

      if (!isMountedRef.current) return;

      const segment: TranslationSegment = {
        id: makeSegmentId(),
        englishText,
        assameseText,
        timestamp: new Date(),
        source: "claude-fallback",
      };
      addSegment(segment);
      onPipelineSuccess();
    },
    [
      addSegment,
      markClaudeBusy,
      markClaudeIdle,
      onPipelineFailure,
      onPipelineSuccess,
      recordApiDuration,
    ],
  );

  const connect = useCallback(() => {
    if (connectionRef.current) return;

    const apiKey = process.env.NEXT_PUBLIC_ELEVENLABS_API_KEY;
    if (!apiKey) {
      const msg =
        "Missing NEXT_PUBLIC_ELEVENLABS_API_KEY. Add it to .env.local and restart the dev server.";
      console.error(`[LINGO] ${msg}`);
      setError(msg);
      return;
    }

    const conn = new ScribeRealtimeConnection({
      apiKey,
      languageCode: "asm",
      sampleRate: 16_000,
      vadSilenceThreshold: 1.0,
      onSessionStarted: () => {
        if (!isMountedRef.current) return;
        setIsConnected(true);
      },
      onPartialTranscript: (text) => {
        if (!isMountedRef.current) return;
        setPartialTranscript(text);
      },
      onCommittedTranscript: (text) => {
        if (!isMountedRef.current) return;
        // Clear the partial — the next utterance will rebuild it.
        setPartialTranscript("");
        void handleCommitted(text);
      },
      onError: (errorType) => {
        if (!isMountedRef.current) return;
        // Surface only the first hard error to the user — verbose error
        // events from the server during a session would otherwise pile up.
        if (!useSessionStore.getState().error) {
          setError(`Transcription error: ${errorType}`);
        }
      },
      onDisconnected: () => {
        if (!isMountedRef.current) return;
        setIsConnected(false);
        setPartialTranscript("");
        // Drop the ref so the next connect() can mint a fresh connection
        // (the existing instance is now in a terminal state).
        connectionRef.current = null;
      },
    });
    connectionRef.current = conn;
    // Token fetch + WebSocket setup is async; fire-and-forget. Errors are
    // routed through onError → store.setError.
    void conn.connect();
  }, [handleCommitted, setError]);

  const disconnect = useCallback(() => {
    const conn = connectionRef.current;
    if (!conn) return;
    conn.disconnect();
    connectionRef.current = null;
    setIsConnected(false);
    setPartialTranscript("");
  }, []);

  const sendAudio = useCallback((pcmBase64: string) => {
    connectionRef.current?.sendAudio(pcmBase64);
  }, []);

  return {
    isConnected,
    partialTranscript,
    connect,
    disconnect,
    sendAudio,
  };
}

export default useRealtimeTranscription;
