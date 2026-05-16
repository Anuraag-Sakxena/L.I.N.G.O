"use client";

import { AnimatePresence, motion } from "framer-motion";
import { WifiOff } from "lucide-react";

import { useSessionStore } from "@/stores/sessionStore";

export function ConnectivityIndicator() {
  const isOnline = useSessionStore((s) => s.isOnline);
  const slow = useSessionStore((s) => s.slowConnection);

  return (
    <AnimatePresence mode="wait">
      {!isOnline ? (
        <motion.div
          key="offline"
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.8 }}
          transition={{ type: "spring", stiffness: 300, damping: 25 }}
          aria-label="Offline"
          role="status"
          className="glass flex items-center gap-1.5 rounded-full px-3 py-1.5"
        >
          <WifiOff className="h-3 w-3 text-accent-amber" strokeWidth={2} />
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-accent-amber">
            Offline
          </span>
        </motion.div>
      ) : slow ? (
        <motion.div
          key="slow"
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.8 }}
          transition={{ type: "spring", stiffness: 300, damping: 25 }}
          aria-label="Slow connection"
          role="status"
          className="glass rounded-full px-3 py-1.5"
        >
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-accent-amber">
            Slow
          </span>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

export default ConnectivityIndicator;
