"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ArrowDown } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type UIEvent,
} from "react";

import { useSessionStore } from "@/stores/sessionStore";
import type { EnglishTranslation } from "@/types";

const STICK_TO_BOTTOM_PX = 60;

export function EnglishPanel() {
  // Render English in Assamese-arrival order via id lookup. Claude calls
  // run in parallel and may complete out of order; this preserves a stable
  // sequence in the panel.
  const assameseSegments = useSessionStore((s) => s.assameseSegments);
  const englishMap = useSessionStore((s) => s.englishTranslations);
  const pendingCount = useSessionStore((s) => s.pendingTranslationIds.size);
  const reducedMotion = useReducedMotion() ?? false;

  const orderedTranslations = useMemo<EnglishTranslation[]>(() => {
    const out: EnglishTranslation[] = [];
    for (const seg of assameseSegments) {
      const t = englishMap[seg.id];
      if (t) out.push(t);
    }
    return out;
  }, [assameseSegments, englishMap]);

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
          lastSeenCountRef.current = orderedTranslations.length;
          setUnseenCount(0);
        }
      }
    },
    [orderedTranslations.length],
  );

  useEffect(() => {
    if (orderedTranslations.length === 0) {
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
      lastSeenCountRef.current = orderedTranslations.length;
      setUnseenCount(0);
    } else {
      setUnseenCount(
        Math.max(0, orderedTranslations.length - lastSeenCountRef.current),
      );
    }
  }, [orderedTranslations.length, reducedMotion]);

  return (
    <motion.div
      initial={{ y: "100%", opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      exit={{ y: "100%", opacity: 0 }}
      transition={{ type: "spring", stiffness: 250, damping: 28, delay: 0.1 }}
      role="region"
      aria-label="English translation"
      className="relative flex flex-1 min-h-0 flex-col overflow-hidden rounded-3xl border border-white/[0.08] bg-white/[0.05] shadow-[0_8px_32px_rgba(0,0,0,0.30)]"
      style={{
        backdropFilter: "blur(24px)",
        WebkitBackdropFilter: "blur(24px)",
      }}
    >
      {/* Header label */}
      <div className="flex shrink-0 items-center justify-between px-4 pt-3 pb-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-cyan-300">
          English
        </span>
        <span className="font-mono text-[10px] tabular-nums text-white/30">
          {orderedTranslations.length}
        </span>
      </div>

      {/* Scroll area */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        role="log"
        aria-live="polite"
        className="flex-1 overflow-y-auto px-4 pb-3"
        style={{ WebkitOverflowScrolling: "touch" }}
      >
        {orderedTranslations.length === 0 && pendingCount === 0 ? (
          <div className="flex min-h-[80px] items-center justify-center">
            <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-white/20">
              Waiting for speech…
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <AnimatePresence initial={false}>
              {orderedTranslations.map((t) => (
                <motion.p
                  key={t.id}
                  layout
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ type: "spring", stiffness: 300, damping: 28 }}
                  className={
                    t.text === "[Translation failed]"
                      ? "text-[14px] italic text-accent-red/60"
                      : "text-[15px] leading-relaxed text-white/90"
                  }
                >
                  {t.text}
                </motion.p>
              ))}
            </AnimatePresence>

            {/* Pulsing "Translating…" placeholder for in-flight Claude calls. */}
            <AnimatePresence>
              {pendingCount > 0 ? (
                <motion.p
                  key="pending"
                  initial={{ opacity: 0 }}
                  animate={
                    reducedMotion
                      ? { opacity: 0.35 }
                      : { opacity: [0.2, 0.5, 0.2] }
                  }
                  exit={{ opacity: 0 }}
                  transition={
                    reducedMotion
                      ? { duration: 0.2 }
                      : { duration: 1.5, repeat: Infinity, ease: "easeInOut" }
                  }
                  className="text-[13px] italic text-white/30"
                  aria-live="polite"
                >
                  {pendingCount === 1
                    ? "Translating…"
                    : `Translating ${pendingCount}…`}
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
            key="new-en"
            type="button"
            onClick={scrollToBottom}
            whileTap={{ scale: 0.95 }}
            initial={{ y: 8, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 8, opacity: 0 }}
            transition={{ type: "spring", stiffness: 300, damping: 25 }}
            aria-label="Scroll to latest"
            className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-white/[0.1] bg-white/[0.07] px-3 py-1 font-mono text-[10px] text-cyan-300 shadow-[0_4px_16px_rgba(0,0,0,0.3)] backdrop-blur-sm"
          >
            <ArrowDown className="h-3 w-3" strokeWidth={2.5} />
            <span>{unseenCount} new</span>
          </motion.button>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

export default EnglishPanel;
