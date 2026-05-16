"use client";

import { useEffect, useState } from "react";

// Renders during SSR + first paint with `system-ui` so it's visible before the
// Plus Jakarta Sans webfont finishes loading. Fades out on mount and unmounts
// 350ms later so it doesn't sit in the DOM forever.
export function Splash() {
  const [visible, setVisible] = useState(true);
  const [opacity, setOpacity] = useState(1);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setOpacity(0));
    const timer = setTimeout(() => setVisible(false), 350);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
    };
  }, []);

  if (!visible) return null;

  return (
    <div
      aria-hidden
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        background: "#0A0F1C",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        transition: "opacity 0.3s ease",
        opacity,
        pointerEvents: opacity === 0 ? "none" : "auto",
      }}
    >
      <span
        style={{
          fontFamily: "system-ui, -apple-system, sans-serif",
          fontSize: 32,
          fontWeight: 300,
          letterSpacing: 4,
          color: "#00D4AA",
        }}
      >
        LINGO
      </span>
    </div>
  );
}

export default Splash;
