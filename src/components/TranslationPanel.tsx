"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { AlertTriangle, ArrowDown } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type UIEvent,
} from "react";

import TranslationCard from "@/components/TranslationCard";
import { useSessionStore } from "@/stores/sessionStore";

const STICK_TO_BOTTOM_PX = 80;

function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const mm = Math.floor(total / 60).toString().padStart(2, "0");
  const ss = (total % 60).toString().padStart(2, "0");
  return `${mm}:${ss}`;
}

export interface TranslationPanelProps {
  /** Called when the user taps "End Session". */
  onStop: () => void;
  /** Called when the user taps "Clear transcript". */
  onClear: () => void;
  /** Live partial transcript from Scribe — updates as the user speaks. */
  partialTranscript?: string;
}

export function TranslationPanel({
  onStop,
  onClear,
  partialTranscript = "",
}: TranslationPanelProps) {
  const isListening = useSessionStore((s) => s.isListening);
  const sessionStartTime = useSessionStore((s) => s.sessionStartTime);
  const segments = useSessionStore((s) => s.segments);
  const slowChunkProcessing = useSessionStore((s) => s.slowChunkProcessing);
  const warningBannerVisible = useSessionStore(
    (s) => s.warningBannerVisible,
  );

  const reducedMotion = useReducedMotion() ?? false;
  const scrollRef = useRef<HTMLDivElement>(null);

  // Timer state — ticks while listening, freezes after stop.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isListening || !sessionStartTime) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isListening, sessionStartTime]);
  const elapsedMs = sessionStartTime ? now - sessionStartTime : 0;
  const timer = formatTime(elapsedMs);
  const segmentCount = segments.length;

  // Scroll position tracking (carried over from Prompt 7).
  const [isAtBottom, setIsAtBottom] = useState(true);
  const isAtBottomRef = useRef(true);
  const [unseenCount, setUnseenCount] = useState(0);
  const lastSeenCountRef = useRef(0);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({
      top: el.scrollHeight,
      behavior: reducedMotion ? "auto" : "smooth",
    });
  }, [reducedMotion]);

  const handleScroll = useCallback(
    (_e: UIEvent<HTMLDivElement>) => {
      const el = scrollRef.current;
      if (!el) return;
      const atBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight < STICK_TO_BOTTOM_PX;
      if (atBottom !== isAtBottomRef.current) {
        isAtBottomRef.current = atBottom;
        setIsAtBottom(atBottom);
        if (atBottom) {
          lastSeenCountRef.current = segments.length;
          setUnseenCount(0);
        }
      }
    },
    [segments.length],
  );

  // Auto-scroll only when anchored to the bottom; otherwise track unseen.
  useEffect(() => {
    if (segments.length === 0) {
      lastSeenCountRef.current = 0;
      setUnseenCount(0);
      return;
    }
    if (isAtBottomRef.current) {
      const el = scrollRef.current;
      if (el) {
        el.scrollTo({
          top: el.scrollHeight,
          behavior: reducedMotion ? "auto" : "smooth",
        });
      }
      lastSeenCountRef.current = segments.length;
      setUnseenCount(0);
    } else {
      setUnseenCount(
        Math.max(0, segments.length - lastSeenCountRef.current),
      );
    }
  }, [segments.length, reducedMotion]);

  return (
    <motion.div
      initial={{ y: "100%", opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      exit={{ y: "100%", opacity: 0 }}
      transition={{
        type: "spring",
        stiffness: 250,
        damping: 28,
        delay: 0.1,
      }}
      role="region"
      aria-label="Translation session"
      className="fixed inset-x-0 bottom-0 z-20 flex max-h-[60dvh] flex-col overflow-hidden rounded-t-[28px] border-t border-white/[0.08] bg-white/[0.05] shadow-[0_-8px_32px_rgba(0,0,0,0.4),inset_0_1px_0_rgba(255,255,255,0.06)]"
      style={{
        backdropFilter: "blur(24px)",
        WebkitBackdropFilter: "blur(24px)",
      }}
    >
      {/* Warning banner */}
      <AnimatePresence>
        {warningBannerVisible && (
          <motion.div
            key="warning"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ type: "spring", stiffness: 300, damping: 28 }}
            role="status"
            aria-live="polite"
            className="flex items-center gap-2 border-b border-accent-amber/20 bg-accent-amber/[0.10] px-4 py-2"
          >
            <AlertTriangle
              className="h-3.5 w-3.5 shrink-0 text-accent-amber"
              strokeWidth={2}
            />
            <p className="font-mono text-[10px] uppercase tracking-[0.15em] text-accent-amber">
              Translation having trouble — check your connection
            </p>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Timer + segment count */}
      <div className="flex items-center justify-center gap-3 border-b border-white/[0.05] py-3">
        <span className="font-mono text-[12px] tabular-nums tracking-wide text-white/50">
          {timer}
        </span>
        <span className="text-white/20">·</span>
        <span className="font-mono text-[11px] text-white/40">
          {segmentCount} {segmentCount === 1 ? "segment" : "segments"}
        </span>
      </div>

      {/* Live partial transcript — appears as Scribe hears speech and is
          cleared on commit (when the segment lands in the feed below). */}
      <AnimatePresence>
        {partialTranscript ? (
          <motion.div
            key="partial-transcript"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden border-b border-white/[0.05] px-4 py-2"
            aria-live="polite"
          >
            <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-accent-teal/60">
              Hearing
            </span>
            <p className="mt-1 font-assamese text-[13px] text-white/45">
              {partialTranscript}
            </p>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* Scroll area */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        role="log"
        aria-live="polite"
        aria-label="Translation feed"
        className="flex-1 overflow-y-auto px-4 py-3"
        style={{ WebkitOverflowScrolling: "touch" }}
      >
        {segmentCount === 0 ? (
          <div className="flex min-h-[160px] items-center justify-center">
            <motion.p
              animate={
                reducedMotion
                  ? { opacity: 0.45 }
                  : { opacity: [0.3, 0.6, 0.3] }
              }
              transition={
                reducedMotion
                  ? { duration: 0 }
                  : { duration: 2, repeat: Infinity, ease: "easeInOut" }
              }
              className="text-[13px] font-light text-white/30"
            >
              Listening for Assamese speech...
            </motion.p>
          </div>
        ) : (
          <div className="flex flex-col gap-2.5">
            <AnimatePresence initial={false}>
              {segments.map((segment, i) => (
                <TranslationCard
                  key={segment.id}
                  segment={segment}
                  index={i}
                />
              ))}
            </AnimatePresence>

            <AnimatePresence>
              {slowChunkProcessing && (
                <motion.div
                  key="translating-indicator"
                  initial={{ opacity: 0, y: 4 }}
                  animate={
                    reducedMotion
                      ? { opacity: 0.7, y: 0 }
                      : { opacity: [0.4, 0.8, 0.4], y: 0 }
                  }
                  exit={{ opacity: 0, y: 4 }}
                  transition={
                    reducedMotion
                      ? { duration: 0.2 }
                      : {
                          opacity: {
                            duration: 1.4,
                            repeat: Infinity,
                            ease: "easeInOut",
                          },
                          y: { duration: 0.2 },
                        }
                  }
                  className="flex items-center justify-center gap-2 py-2"
                  aria-live="polite"
                >
                  <motion.span
                    className="h-1.5 w-1.5 rounded-full bg-accent-indigo"
                    animate={
                      reducedMotion ? { scale: 1 } : { scale: [1, 1.4, 1] }
                    }
                    transition={
                      reducedMotion
                        ? { duration: 0 }
                        : {
                            duration: 1.4,
                            repeat: Infinity,
                            ease: "easeInOut",
                          }
                    }
                  />
                  <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-accent-indigo">
                    Translating…
                  </span>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}
      </div>

      {/* "↓ N new" pill floats above the footer when scrolled away */}
      <AnimatePresence>
        {!isAtBottom && unseenCount > 0 && segmentCount > 0 && (
          <motion.button
            key="new-translations"
            type="button"
            onClick={scrollToBottom}
            whileTap={{ scale: 0.95 }}
            initial={{ y: 10, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 10, opacity: 0 }}
            transition={{ type: "spring", stiffness: 300, damping: 25 }}
            aria-label="Scroll to latest translations"
            className="absolute bottom-[88px] left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-white/[0.1] bg-white/[0.07] px-3 py-1.5 font-mono text-[11px] text-accent-teal shadow-[0_4px_16px_rgba(0,0,0,0.3)] backdrop-blur-sm"
          >
            <ArrowDown className="h-3 w-3" strokeWidth={2.5} />
            <span>
              {unseenCount} new translation{unseenCount === 1 ? "" : "s"}
            </span>
          </motion.button>
        )}
      </AnimatePresence>

      {/* Footer — End Session OR Clear transcript */}
      <div
        className="flex flex-col items-center gap-2 px-4 pt-3"
        style={{
          paddingBottom: "calc(max(env(safe-area-inset-bottom), 0px) + 16px)",
        }}
      >
        <AnimatePresence mode="wait" initial={false}>
          {isListening ? (
            <motion.button
              key="end-session"
              type="button"
              onClick={onStop}
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
          ) : segmentCount > 0 ? (
            <motion.button
              key="clear-transcript"
              type="button"
              onClick={onClear}
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
  );
}

export default TranslationPanel;
