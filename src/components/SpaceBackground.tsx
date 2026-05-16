"use client";

import type { CSSProperties } from "react";

interface Star {
  left: string;
  top: string;
  size: number;
  opacity: number;
  twinkle: boolean;
  delay: number;
  duration: number;
}

// Tiny seeded PRNG so SSR and the client agree on star positions and we don't
// get a hydration mismatch.
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STAR_COUNT = 130;

// Built once at module load. Pure function of the seed — identical on
// server and client.
const STARS: ReadonlyArray<Star> = (() => {
  const rand = mulberry32(20260515);
  const out: Star[] = [];
  for (let i = 0; i < STAR_COUNT; i++) {
    const size = rand() < 0.85 ? 1 : 2;
    out.push({
      left: `${(rand() * 100).toFixed(3)}%`,
      top: `${(rand() * 100).toFixed(3)}%`,
      size,
      opacity: 0.15 + rand() * 0.25,
      twinkle: rand() < 0.1,
      delay: rand() * 8,
      duration: 3 + rand() * 5,
    });
  }
  return out;
})();

type StarStyle = CSSProperties & { "--star-opacity"?: string };

export function SpaceBackground() {
  return (
    <div aria-hidden className="space-bg">
      {STARS.map((s, i) => {
        const style: StarStyle = {
          left: s.left,
          top: s.top,
          width: `${s.size}px`,
          height: `${s.size}px`,
          "--star-opacity": s.opacity.toFixed(3),
        };
        if (s.twinkle) {
          style.animationDelay = `${s.delay.toFixed(2)}s`;
          style.animationDuration = `${s.duration.toFixed(2)}s`;
        }
        return (
          <span
            key={i}
            className={s.twinkle ? "star star-twinkle" : "star"}
            style={style}
          />
        );
      })}
    </div>
  );
}

export default SpaceBackground;
