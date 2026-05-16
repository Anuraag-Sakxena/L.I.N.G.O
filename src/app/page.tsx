"use client";

import { AnimatePresence, MotionConfig, motion } from "framer-motion";
import { AlertCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import AssamesePanel from "@/components/AssamesePanel";
import ConnectivityIndicator from "@/components/ConnectivityIndicator";
import EnglishPanel from "@/components/EnglishPanel";
import Orb, { type OrbHandle } from "@/components/Orb";
import SpaceBackground from "@/components/SpaceBackground";
import { useAudioCapture } from "@/hooks/useAudioCapture";
import { useRealtimeTranscription } from "@/hooks/useRealtimeTranscription";
import { useSessionStore } from "@/stores/sessionStore";

const TOGGLE_DEBOUNCE_MS = 500;
const FOREGROUND_RECOVERY_GAP_MS = 3000;
const HINT_FADE_AFTER_MS = 3000;
const PANEL_GAP_PX = 24;

type Platform = "ios" | "android" | "desktop";

function detectPlatform(): Platform {
  if (typeof navigator === "undefined") return "desktop";
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  if (/Android/i.test(ua)) return "android";
  return "desktop";
}

const DENIAL_MESSAGES: Record<Platform, string> = {
  ios:
    "Mic access is blocked. Open Settings → Safari → Microphone and allow access for this site.",
  android:
    "Mic access is blocked. Tap the lock icon in the address bar and allow Microphone.",
  desktop:
    "Mic access is blocked. Please allow microphone access in your browser settings.",
};

function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const mm = Math.floor(total / 60).toString().padStart(2, "0");
  const ss = (total % 60).toString().padStart(2, "0");
  return `${mm}:${ss}`;
}

export default function Page() {
  const isListening = useSessionStore((s) => s.isListening);
  const assameseCount = useSessionStore((s) => s.assameseSegments.length);
  const englishCount = useSessionStore(
    (s) => Object.keys(s.englishTranslations).length,
  );
  const sessionStartTime = useSessionStore((s) => s.sessionStartTime);
  const error = useSessionStore((s) => s.error);
  const startListening = useSessionStore((s) => s.startListening);
  const stopListening = useSessionStore((s) => s.stopListening);
  const clearSession = useSessionStore((s) => s.clearSession);
  const setError = useSessionStore((s) => s.setError);

  const {
    isCapturing,
    stream,
    currentVolume,
    error: micError,
    startCapture,
    stopCapture,
    setPCMHandler,
  } = useAudioCapture();

  const {
    partialTranscript,
    connect: connectTranscription,
    disconnect: disconnectTranscription,
    sendAudio,
  } = useRealtimeTranscription();

  const [isStarting, setIsStarting] = useState(false);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [hintVisible, setHintVisible] = useState(true);

  const orbRef = useRef<OrbHandle | null>(null);
  const lastPulsedEnglishCountRef = useRef(0);
  const micDenialCountRef = useRef(0);
  const lastForegroundCheckRef = useRef(Date.now());

  // Live timer (ticks while listening, freezes after stop).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isListening || !sessionStartTime) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isListening, sessionStartTime]);
  const elapsedMs = sessionStartTime ? now - sessionStartTime : 0;

  // Startup sanity check.
  useEffect(() => {
    if (!process.env.NEXT_PUBLIC_ELEVENLABS_API_KEY) {
      console.error(
        "[LINGO] Missing NEXT_PUBLIC_ELEVENLABS_API_KEY. Transcription will not work. Add it to .env.local and restart the dev server.",
      );
    }
  }, []);

  // PCM frames → WebSocket. sendAudio is a stable no-op when the socket
  // isn't open.
  useEffect(() => {
    setPCMHandler((b64) => sendAudio(b64));
    return () => setPCMHandler(null);
  }, [setPCMHandler, sendAudio]);

  // Mirror mic errors → store. Platform-specific copy after 2nd denial.
  useEffect(() => {
    if (!micError) return;
    const isDenial = /denied|allow mic access/i.test(micError);
    if (isDenial) {
      micDenialCountRef.current += 1;
      if (micDenialCountRef.current >= 2) {
        setError(DENIAL_MESSAGES[detectPlatform()]);
        return;
      }
    }
    setError(micError);
  }, [micError, setError]);

  // Online/offline → connectivity indicator only.
  useEffect(() => {
    function handleOnline() {
      console.log("[LINGO] Back online");
      useSessionStore.getState().setOnline(true);
    }
    function handleOffline() {
      console.log("[LINGO] Offline");
      useSessionStore.getState().setOnline(false);
    }
    if (typeof navigator !== "undefined") {
      useSessionStore.getState().setOnline(navigator.onLine);
    }
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  // Foreground recovery: restart capture + Scribe if the audio track died.
  useEffect(() => {
    function handleVisibility() {
      const t = Date.now();
      if (document.hidden) {
        console.log("[LINGO] App backgrounded");
        lastForegroundCheckRef.current = t;
        return;
      }
      const gap = t - lastForegroundCheckRef.current;
      lastForegroundCheckRef.current = t;
      console.log(`[LINGO] App foregrounded after ${gap}ms`);

      if (!stream) return;
      const track = stream.getAudioTracks()[0];
      if (gap > FOREGROUND_RECOVERY_GAP_MS) {
        console.log(
          `[LINGO] Resumed after ${gap}ms — any in-flight audio is stale`,
        );
      }
      if (track && track.readyState === "ended") {
        console.log("[LINGO] Audio track ended — restarting capture + Scribe");
        disconnectTranscription();
        stopCapture();
        void (async () => {
          const ok = await startCapture();
          if (ok) {
            connectTranscription();
            console.log("[LINGO] Capture + Scribe restarted after wake");
          }
        })();
      }
    }
    document.addEventListener("visibilitychange", handleVisibility);
    return () =>
      document.removeEventListener("visibilitychange", handleVisibility);
  }, [
    stream,
    stopCapture,
    startCapture,
    connectTranscription,
    disconnectTranscription,
  ]);

  // Orb pulse on each new completed English translation.
  useEffect(() => {
    if (englishCount > lastPulsedEnglishCountRef.current) {
      orbRef.current?.triggerPulse();
      lastPulsedEnglishCountRef.current = englishCount;
    }
  }, [englishCount]);

  // Fade the "Tap to listen" hint after 3 seconds.
  useEffect(() => {
    const timer = setTimeout(() => setHintVisible(false), HINT_FADE_AFTER_MS);
    return () => clearTimeout(timer);
  }, []);

  const handleStart = useCallback(async () => {
    if (isTransitioning) return;
    setHintVisible(false);
    setIsTransitioning(true);
    try {
      setError(null);
      setIsStarting(true);
      try {
        const ok = await startCapture();
        if (ok) {
          micDenialCountRef.current = 0;
          connectTranscription();
          await startListening();
        }
      } finally {
        setIsStarting(false);
      }
    } finally {
      setTimeout(() => setIsTransitioning(false), TOGGLE_DEBOUNCE_MS);
    }
  }, [
    isTransitioning,
    setError,
    startCapture,
    startListening,
    connectTranscription,
  ]);

  const handleStop = useCallback(() => {
    if (isTransitioning) return;
    setIsTransitioning(true);
    disconnectTranscription();
    stopCapture();
    stopListening();
    setTimeout(() => setIsTransitioning(false), TOGGLE_DEBOUNCE_MS);
  }, [isTransitioning, stopCapture, stopListening, disconnectTranscription]);

  const handleClear = useCallback(() => {
    clearSession();
    lastPulsedEnglishCountRef.current = 0;
  }, [clearSession]);

  const handleRetry = useCallback(async () => {
    setError(null);
    if (isListening) return;
    setIsStarting(true);
    try {
      const ok = await startCapture();
      if (ok) {
        connectTranscription();
        await startListening();
      }
    } finally {
      setIsStarting(false);
    }
  }, [
    isListening,
    setError,
    startCapture,
    startListening,
    connectTranscription,
  ]);

  const orbVolume = isCapturing ? currentVolume : 0;
  const panelsActive = !error && (isListening || assameseCount > 0);
  const showHint = hintVisible && !panelsActive && !error;
  const showTapTarget = !panelsActive && !error;

  return (
    <MotionConfig reducedMotion="user">
      <SpaceBackground />

      {/* Orb — ALWAYS centered, never moves. */}
      <div className="pointer-events-none fixed inset-0 z-10 flex items-center justify-center">
        <Orb ref={orbRef} volume={orbVolume} />
      </div>

      {/* Tap target + hint — dormant only. */}
      <div className="pointer-events-none fixed inset-0 z-[15] flex items-center justify-center">
        <AnimatePresence>
          {showTapTarget && (
            <motion.button
              key="orb-tap-target"
              type="button"
              onClick={handleStart}
              disabled={isStarting || isTransitioning}
              aria-label="Start listening"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              whileTap={isStarting ? undefined : { scale: 0.95 }}
              className="pointer-events-auto rounded-full disabled:cursor-wait"
              style={{ width: "min(55vw, 240px)", aspectRatio: "1" }}
            />
          )}
        </AnimatePresence>

        <AnimatePresence>
          {showHint && (
            <motion.p
              key="hint"
              initial={{ opacity: 0 }}
              animate={{ opacity: 0.4 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.8 }}
              className="pointer-events-none absolute bottom-[20%] left-1/2 -translate-x-1/2 font-mono text-[11px] uppercase tracking-[0.25em] text-white/30"
            >
              Tap to listen
            </motion.p>
          )}
        </AnimatePresence>
      </div>

      {/* Dual panels — float above the orb when active. The orb peeks
          through the frosted glass and through the gap between panels. */}
      <AnimatePresence>
        {panelsActive && (
          <motion.div
            key="dual-panels"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            className="fixed inset-0 z-20 flex flex-col gap-0 px-4"
            style={{
              // +12px below the safe-area-top so the Assamese panel sits
              // clear of the iPhone Dynamic Island.
              paddingTop: "calc(max(env(safe-area-inset-top), 16px) + 12px)",
              paddingBottom: "max(env(safe-area-inset-bottom), 16px)",
            }}
          >
            {/* Assamese panel — 0.7× the English panel's height. The
                wrapper claims that flex share; the panel's own flex-1
                fills the wrapper. */}
            <div className="flex flex-[0.7] min-h-0 flex-col">
              <AssamesePanel partialTranscript={partialTranscript} />
            </div>

            {/* The 24px sliver where the sharp orb shows through. */}
            <div
              className="shrink-0"
              style={{ height: PANEL_GAP_PX }}
              aria-hidden
            />

            <div className="flex flex-1 min-h-0 flex-col">
              <EnglishPanel />
            </div>

            {/* Footer: timer + segment count + stop / clear */}
            <div className="flex shrink-0 flex-col items-center gap-2 pt-3">
              <span className="font-mono text-[11px] tabular-nums text-white/40">
                {formatTime(elapsedMs)}
              </span>

              <AnimatePresence mode="wait" initial={false}>
                {isListening ? (
                  <motion.button
                    key="end-session"
                    type="button"
                    onClick={handleStop}
                    whileTap={{ scale: 0.96 }}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    aria-label="End session"
                    className="mx-auto flex items-center gap-2.5 rounded-full border border-white/[0.1] bg-white/[0.07] px-6 py-3 backdrop-blur-sm transition-colors hover:bg-white/[0.12] active:bg-white/[0.15]"
                  >
                    <span className="block h-3 w-3 rounded-[3px] bg-accent-red" />
                    <span className="text-[13px] font-medium tracking-wide text-white/70">
                      End Session
                    </span>
                  </motion.button>
                ) : assameseCount > 0 ? (
                  <motion.button
                    key="clear-transcript"
                    type="button"
                    onClick={handleClear}
                    whileTap={{ scale: 0.96 }}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    aria-label="Clear transcript"
                    className="font-mono text-[11px] uppercase tracking-widest text-white/25 transition-colors hover:text-white/50"
                  >
                    Clear transcript
                  </motion.button>
                ) : null}
              </AnimatePresence>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Connectivity indicator — top-right */}
      <div
        className="fixed right-4 z-40"
        style={{ top: "max(env(safe-area-inset-top), 16px)" }}
      >
        <ConnectivityIndicator />
      </div>

      {/* Error overlay */}
      <AnimatePresence>
        {error && (
          <motion.div
            key="error-overlay"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            transition={{ type: "spring", stiffness: 300, damping: 25 }}
            role="alert"
            className="glass fixed bottom-[25%] left-1/2 z-50 w-[85vw] max-w-sm -translate-x-1/2 rounded-2xl border border-accent-red/20 p-6 text-center"
          >
            <AlertCircle
              className="mx-auto mb-3 text-accent-red"
              size={32}
              strokeWidth={1.5}
            />
            <p className="mb-1 text-[14px] text-white/80">{error}</p>
            <motion.button
              type="button"
              onClick={handleRetry}
              whileTap={{ scale: 0.96 }}
              className="mt-4 rounded-full border border-white/[0.1] bg-white/[0.08] px-5 py-2 text-[12px] font-medium text-white/60 transition-colors hover:bg-white/[0.12]"
            >
              Try Again
            </motion.button>
          </motion.div>
        )}
      </AnimatePresence>
    </MotionConfig>
  );
}
