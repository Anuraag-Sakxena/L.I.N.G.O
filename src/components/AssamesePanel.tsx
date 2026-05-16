"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ArrowDown } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type UIEvent,
} from "react";

import { useSessionStore } from "@/stores/sessionStore";

const STICK_TO_BOTTOM_PX = 60;

export interface AssamesePanelProps {
  partialTranscript: string;
}

export function AssamesePanel({ partialTranscript }: AssamesePanelProps) {
  const segments = useSessionStore((s) => s.assameseSegments);
  const reducedMotion = useReducedMotion() ?? false;

  const scrollRef = useRef<HTMLDivElement>(null);
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

  // Auto-scroll on new content if anchored at the bottom; otherwise track
  // unseen count for the "↓ N new" pill.
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
      setUnseenCount(Math.max(0, segments.length - lastSeenCountRef.current));
    }
  }, [segments.length, reducedMotion]);

  // Also scroll when the partial extends past the bottom edge while we're
  // at the bottom — keeps the live-typing visible.
  useEffect(() => {
    if (!partialTranscript || !isAtBottomRef.current) return;
    const el = scrollRef.current;
    if (el) {
      el.scrollTo({ top: el.scrollHeight, behavior: "auto" });
    }
  }, [partialTranscript]);

  return (
    <motion.div
      initial={{ y: "-100%", opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      exit={{ y: "-100%", opacity: 0 }}
      transition={{ type: "spring", stiffness: 250, damping: 28 }}
      role="region"
      aria-label="Assamese transcription"
      className="relative flex flex-1 min-h-0 flex-col overflow-hidden rounded-3xl border border-white/[0.08] bg-white/[0.05] shadow-[0_8px_32px_rgba(0,0,0,0.30)]"
      style={{
        backdropFilter: "blur(24px)",
        WebkitBackdropFilter: "blur(24px)",
      }}
    >
      {/* Header label */}
      <div className="flex shrink-0 items-center justify-between px-4 pt-3 pb-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-accent-teal">
          অসমীয়া
        </span>
        <span className="font-mono text-[10px] tabular-nums text-white/30">
          {segments.length}
        </span>
      </div>

      {/* Scroll area */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        role="log"
        aria-live="polite"
        className="hide-scrollbar flex-1 overflow-y-auto px-4 pb-3"
        style={{ WebkitOverflowScrolling: "touch" }}
      >
        {segments.length === 0 && !partialTranscript ? (
          <div className="flex min-h-[80px] items-center justify-center">
            <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-white/20">
              Listening…
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <AnimatePresence initial={false}>
              {segments.map((segment) => (
                <motion.p
                  key={segment.id}
                  layout
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ type: "spring", stiffness: 300, damping: 28 }}
                  className="font-assamese text-[15px] leading-relaxed text-white/80"
                >
                  {segment.text}
                </motion.p>
              ))}
            </AnimatePresence>

            {/* Live partial — appears below committed text in lower opacity. */}
            <AnimatePresence>
              {partialTranscript ? (
                <motion.p
                  key="partial"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.2 }}
                  className="font-assamese text-[15px] leading-relaxed text-white/40"
                  aria-live="polite"
                >
                  {partialTranscript}
                </motion.p>
              ) : null}
            </AnimatePresence>
          </div>
        )}
      </div>

      {/* "↓ N new" pill */}
      <AnimatePresence>
        {!isAtBottom && unseenCount > 0 && (
          <motion.button
            key="new-asm"
            type="button"
            onClick={scrollToBottom}
            whileTap={{ scale: 0.95 }}
            initial={{ y: 8, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 8, opacity: 0 }}
            transition={{ type: "spring", stiffness: 300, damping: 25 }}
            aria-label="Scroll to latest"
            className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-white/[0.1] bg-white/[0.07] px-3 py-1 font-mono text-[10px] text-accent-teal shadow-[0_4px_16px_rgba(0,0,0,0.3)] backdrop-blur-sm"
          >
            <ArrowDown className="h-3 w-3" strokeWidth={2.5} />
            <span>{unseenCount} new</span>
          </motion.button>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

export default AssamesePanel;
