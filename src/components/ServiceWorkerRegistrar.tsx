"use client";

import { useEffect } from "react";

// Registers /sw.js on first mount. Only runs in production builds — dev mode
// + service workers + Next.js HMR is a notorious combination of pain.
export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker
      .register("/sw.js")
      .catch((err) => {
        console.warn("[LINGO] SW registration failed:", err);
      });
  }, []);
  return null;
}

export default ServiceWorkerRegistrar;
