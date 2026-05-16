"use client";

import { useEffect, useImperativeHandle, type Ref } from "react";
import { useReducedMotion } from "framer-motion";

import { useOrb } from "@/hooks/useOrb";

export interface OrbHandle {
  /** Fire a one-shot displacement burst on the orb's surface. */
  triggerPulse: () => void;
}

export interface OrbProps {
  /** 0..1 amplitude. When omitted, the hook runs its built-in mock data. */
  volume?: number;
  ref?: Ref<OrbHandle>;
}

export function Orb({ volume, ref }: OrbProps) {
  const useMockData = volume === undefined;
  const reducedMotion = useReducedMotion() ?? false;
  const { containerRef, setVolume, triggerPulse } = useOrb({
    useMockData,
    reducedMotion,
  });

  useEffect(() => {
    if (volume !== undefined) setVolume(volume);
  }, [volume, setVolume]);

  useImperativeHandle(ref, () => ({ triggerPulse }), [triggerPulse]);

  return (
    <div
      ref={containerRef}
      aria-hidden
      className="pointer-events-none fixed inset-0 z-[1]"
    />
  );
}

export default Orb;
