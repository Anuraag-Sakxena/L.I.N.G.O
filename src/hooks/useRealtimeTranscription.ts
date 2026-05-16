"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { translateWithClaude } from "@/services/claude";
import { ScribeRealtimeConnection } from "@/services/elevenlabs";
import { useSessionStore } from "@/stores/sessionStore";
import type { AssameseSegment, EnglishTranslation } from "@/types";

const CLAUDE_TIMEOUT_MS = 15_000;
const SLOW_API_THRESHOLD_MS = 5_000;
const FAILURES_FOR_WARNING = 3;
const WARNING_AUTO_DISMISS_MS = 10_000;

// Cap concurrent Claude calls. Beyond this, queue. Scribe NEVER stops.
const MAX_CONCURRENT_TRANSLATIONS = 5;

// Scribe sometimes still hallucinates English residue on silence. Same
// patterns as before — applied to the committed Assamese transcript before
// we put it in the panel.
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

  // Parallel-translation state — refs because they shouldn't trigger renders.
  const activeTranslationsRef = useRef(0);
  const translationQueueRef = useRef<Array<{ id: string; text: string }>>([]);
  const controllersRef = useRef<Set<AbortController>>(new Set());

  // Resilience tracking carried over from the previous orchestrator.
  const consecutiveFailuresRef = useRef(0);
  const apiDurationsRef = useRef<number[]>([]);
  const warningTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const addAssameseSegment = useSessionStore((s) => s.addAssameseSegment);
  const addEnglishTranslation = useSessionStore((s) => s.addEnglishTranslation);
  const addPendingTranslation = useSessionStore((s) => s.addPendingTranslation);
  const removePendingTranslation = useSessionStore(
    (s) => s.removePendingTranslation,
  );
  const setError = useSessionStore((s) => s.setError);
  const setSlowConnection = useSessionStore((s) => s.setSlowConnection);
  const setWarningBannerVisible = useSessionStore(
    (s) => s.setWarningBannerVisible,
  );

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
      translationQueueRef.current = [];
      activeTranslationsRef.current = 0;
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

  // Fire a Claude call. Fire-and-forget — never blocks the WS message
  // handler. Up to MAX_CONCURRENT_TRANSLATIONS may run in parallel; beyond
  // that we queue and drain in the .finally() block.
  const translateInBackground = useCallback(
    (segmentId: string, assameseText: string) => {
      const run = async () => {
        if (!isMountedRef.current) return;
        if (activeTranslationsRef.current >= MAX_CONCURRENT_TRANSLATIONS) {
          translationQueueRef.current.push({ id: segmentId, text: assameseText });
          return;
        }

        activeTranslationsRef.current += 1;
        addPendingTranslation(segmentId);

        const controller = new AbortController();
        controllersRef.current.add(controller);
        const timer = setTimeout(() => controller.abort(), CLAUDE_TIMEOUT_MS);
        const start = Date.now();

        try {
          const claudeOut = await translateWithClaude(
            assameseText,
            controller.signal,
          );
          const englishText = claudeOut.trim();
          if (!isMountedRef.current) return;
          if (englishText.length < 2) {
            console.log(
              `[LINGO] Claude returned empty for segment ${segmentId} — skipping`,
            );
            onPipelineFailure();
            return;
          }
          console.log(`[LINGO] Claude translate → "${englishText}"`);
          const translation: EnglishTranslation = {
            id: segmentId,
            text: englishText,
            timestamp: new Date(),
          };
          addEnglishTranslation(translation);
          onPipelineSuccess();
        } catch (err) {
          console.error(
            `[LINGO] Claude failed for segment ${segmentId} (${describeError(err)})`,
          );
          if (isMountedRef.current) {
            // Place a visible failure marker so the bottom panel doesn't
            // silently lag behind the top panel forever.
            addEnglishTranslation({
              id: segmentId,
              text: "[Translation failed]",
              timestamp: new Date(),
            });
            onPipelineFailure();
          }
        } finally {
          clearTimeout(timer);
          controllersRef.current.delete(controller);
          recordApiDuration(Date.now() - start);
          removePendingTranslation(segmentId);
          activeTranslationsRef.current = Math.max(
            0,
            activeTranslationsRef.current - 1,
          );
          // Drain one queued chunk if anything's waiting.
          const next = translationQueueRef.current.shift();
          if (next) translateInBackground(next.id, next.text);
        }
      };
      void run();
    },
    [
      addEnglishTranslation,
      addPendingTranslation,
      removePendingTranslation,
      onPipelineFailure,
      onPipelineSuccess,
      recordApiDuration,
    ],
  );

  // Scribe committed → push Assamese immediately, fire Claude in background.
  // No await. The WS handler returns instantly so the next committed
  // transcript can land while Claude is still working.
  const handleCommitted = useCallback(
    (assameseText: string) => {
      if (!isMountedRef.current) return;
      if (isHallucination(assameseText)) {
        console.log(
          `[LINGO] Hallucination detected: "${assameseText}" — skipping`,
        );
        return;
      }

      const id = makeSegmentId();
      const segment: AssameseSegment = {
        id,
        text: assameseText,
        timestamp: new Date(),
      };
      addAssameseSegment(segment);
      translateInBackground(id, assameseText);
    },
    [addAssameseSegment, translateInBackground],
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
        setPartialTranscript("");
        handleCommitted(text);
      },
      onError: (errorType) => {
        if (!isMountedRef.current) return;
        if (!useSessionStore.getState().error) {
          setError(`Transcription error: ${errorType}`);
        }
      },
      onDisconnected: () => {
        if (!isMountedRef.current) return;
        setIsConnected(false);
        setPartialTranscript("");
        connectionRef.current = null;
      },
    });
    connectionRef.current = conn;
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
