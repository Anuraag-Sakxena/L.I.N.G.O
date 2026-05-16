"use client";

import { motion } from "framer-motion";

import type { TranslationSegment } from "@/types";

export interface TranslationCardProps {
  segment: TranslationSegment;
  index: number;
}

function formatTime(d: Date): string {
  return d.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function TranslationCard({ segment, index }: TranslationCardProps) {
  const isFallback = segment.source === "claude-fallback";
  const alt = index % 2 === 1;

  return (
    <motion.div
      layout
      initial={{ y: 16, opacity: 0, scale: 0.97 }}
      animate={{ y: 0, opacity: 1, scale: 1 }}
      exit={{ y: -8, opacity: 0, scale: 0.97 }}
      transition={{ type: "spring", stiffness: 300, damping: 25 }}
      className={`rounded-2xl border border-white/[0.04] px-[18px] py-[14px] ${
        alt ? "bg-white/[0.06]" : "bg-white/[0.03]"
      }`}
    >
      {segment.assameseText ? (
        <p className="mb-1.5 font-assamese text-[12px] text-text-muted opacity-60">
          {segment.assameseText}
        </p>
      ) : null}
      <p className="text-[15px] leading-relaxed text-text-primary">
        {segment.englishText}
      </p>
      <div className="mt-2 flex items-end justify-between gap-3">
        {isFallback ? (
          <span className="rounded-full bg-accent-indigo/20 px-1.5 py-[2px] font-mono text-[9px] uppercase tracking-wide text-accent-indigo">
            AI
          </span>
        ) : (
          <span aria-hidden />
        )}
        <time
          dateTime={segment.timestamp.toISOString()}
          className="font-mono text-[10px] tabular-nums text-text-muted"
        >
          {formatTime(segment.timestamp)}
        </time>
      </div>
    </motion.div>
  );
}

export default TranslationCard;
