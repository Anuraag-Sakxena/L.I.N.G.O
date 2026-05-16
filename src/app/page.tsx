"use client";

import { AnimatePresence, MotionConfig, motion } from "framer-motion";
import { AlertCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import ConnectivityIndicator from "@/components/ConnectivityIndicator";
import Orb, { type OrbHandle } from "@/components/Orb";
import SpaceBackground from "@/components/SpaceBackground";
import TranslationPanel from "@/components/TranslationPanel";
import { useAudioCapture } from "@/hooks/useAudioCapture";
import { useRealtimeTranscription } from "@/hooks/useRealtimeTranscription";
import { useSessionStore } from "@/stores/sessionStore";

const TOGGLE_DEBOUNCE_MS = 500;
const FOREGROUND_RECOVERY_GAP_MS = 3000;
const HINT_FADE_AFTER_MS = 3000;

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

export default function Page() {
  const isListening = useSessionStore((s) => s.isListening);
  const segmentCount = useSessionStore((s) => s.segments.length);
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
  const lastPulsedSegmentCountRef = useRef(0);
  const micDenialCountRef = useRef(0);
  const lastForegroundCheckRef = useRef(Date.now());

  // Startup sanity check for the ElevenLabs key.
  useEffect(() => {
    if (!process.env.NEXT_PUBLIC_ELEVENLABS_API_KEY) {
      console.error(
        "[LINGO] Missing NEXT_PUBLIC_ELEVENLABS_API_KEY. Transcription will not work. Add it to .env.local and restart the dev server.",
      );
    }
  }, []);

  // PCM frames from useAudioCapture → useRealtimeTranscription's WebSocket.
  // sendAudio is a stable callback and a no-op when the socket isn't open.
  useEffect(() => {
    setPCMHandler((b64) => sendAudio(b64));
    return () => setPCMHandler(null);
  }, [setPCMHandler, sendAudio]);

  // Mirror mic errors → store. Use platform-specific copy after 2nd denial.
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

  // Online / offline listeners — purely for the top-right indicator now.
  // (There's no chunk queue to drain with streaming.)
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

  // Foreground recovery: if the mic track died while backgrounded, restart
  // capture AND re-open the WebSocket so the new stream actually reaches
  // Scribe.
  useEffect(() => {
    function handleVisibility() {
      const now = Date.now();
      if (document.hidden) {
        console.log("[LINGO] App backgrounded");
        lastForegroundCheckRef.current = now;
        return;
      }
      const gap = now - lastForegroundCheckRef.current;
      lastForegroundCheckRef.current = now;
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

  // Orb pulse on each new segment.
  useEffect(() => {
    if (segmentCount > lastPulsedSegmentCountRef.current) {
      orbRef.current?.triggerPulse();
      lastPulsedSegmentCountRef.current = segmentCount;
    }
  }, [segmentCount]);

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
    lastPulsedSegmentCountRef.current = 0;
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

  const panelOpen = !error && (isListening || segmentCount > 0);
  const showHint = hintVisible && !panelOpen && !error;
  const showTapTarget = !panelOpen && !error;

  return (
    <MotionConfig reducedMotion="user">
      <SpaceBackground />

      {/* The orb + its tap surface + hint. The whole group translates up
          when the panel opens to make room. */}
      <motion.div
        className="pointer-events-none fixed inset-0 z-10 flex items-center justify-center"
        animate={{ y: panelOpen ? "-10vh" : "0vh" }}
        transition={{ type: "spring", stiffness: 200, damping: 25 }}
      >
        <Orb ref={orbRef} volume={orbVolume} />

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
      </motion.div>

      {/* Translation panel */}
      <AnimatePresence>
        {panelOpen && (
          <TranslationPanel
            key="panel"
            partialTranscript={partialTranscript}
            onStop={handleStop}
            onClear={handleClear}
          />
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
