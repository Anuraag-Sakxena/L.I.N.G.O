"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface UseAudioCaptureResult {
  isCapturing: boolean;
  stream: MediaStream | null;
  analyserNode: AnalyserNode | null;
  /** 0..1 RMS-derived voice amplitude, React state (throttled to ~20 Hz). */
  currentVolume: number;
  error: string | null;
  startCapture: () => Promise<boolean>;
  stopCapture: () => void;
  /**
   * Register a callback that receives base64-encoded 16-bit PCM at 16 kHz.
   * Pass null to unregister. Safe to call any time — called frames are
   * dropped if no handler is registered.
   */
  setPCMHandler: (cb: ((pcmBase64: string) => void) | null) => void;
}

type WebkitWindow = Window & { webkitAudioContext?: typeof AudioContext };

const TARGET_SAMPLE_RATE = 16_000;
const PROCESSOR_BUFFER = 4096;
const VOLUME_STATE_THROTTLE_MS = 50;
const INTERRUPTION_TIMEOUT_MS = 30_000;
const DRIFT_CHECK_INTERVAL_MS = 5 * 60_000;

function constructAudioContext(): AudioContext {
  const Ctor =
    window.AudioContext ?? (window as WebkitWindow).webkitAudioContext;
  if (!Ctor) {
    throw new Error("AudioContext is not supported on this browser.");
  }
  // Try the modern constructor with a sampleRate hint first. Some Safari
  // builds (and the legacy webkitAudioContext shim) ignore options — fall
  // back to the no-arg form. Either way we re-check `.sampleRate` after.
  try {
    return new Ctor({ sampleRate: TARGET_SAMPLE_RATE });
  } catch {
    return new Ctor();
  }
}

// Linear-interpolation downsample from `inputRate` to `TARGET_SAMPLE_RATE`.
// Cheap and "good enough" for speech — speech energy lives well below the
// Nyquist of 16 kHz, so aliasing isn't audible at this ratio.
function downsampleTo16k(
  input: Float32Array,
  inputRate: number,
): Float32Array {
  if (inputRate === TARGET_SAMPLE_RATE) return input;
  const ratio = inputRate / TARGET_SAMPLE_RATE;
  const outLength = Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = input[idx] ?? 0;
    const b = input[idx + 1] ?? a;
    out[i] = a * (1 - frac) + b * frac;
  }
  return out;
}

function floatToPcm16Base64(floatData: Float32Array): string {
  const len = floatData.length;
  const pcm16 = new Int16Array(len);
  for (let i = 0; i < len; i++) {
    const s = Math.max(-1, Math.min(1, floatData[i]));
    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  // Build the binary string a char at a time — String.fromCharCode(...bytes)
  // hits "Maximum call stack size exceeded" on large arrays.
  const bytes = new Uint8Array(pcm16.buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function useAudioCapture(): UseAudioCaptureResult {
  const [isCapturing, setIsCapturing] = useState(false);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [analyserNode, setAnalyserNode] = useState<AnalyserNode | null>(null);
  const [currentVolume, setCurrentVolume] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const silentGainRef = useRef<GainNode | null>(null);
  const interruptionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const startingRef = useRef(false);

  const pcmHandlerRef = useRef<((pcmBase64: string) => void) | null>(null);

  const setPCMHandler = useCallback(
    (cb: ((pcmBase64: string) => void) | null) => {
      pcmHandlerRef.current = cb;
    },
    [],
  );

  const teardown = useCallback(() => {
    if (processorRef.current) {
      try {
        processorRef.current.disconnect();
      } catch {
        /* ignore */
      }
      processorRef.current.onaudioprocess = null;
      processorRef.current = null;
    }
    if (silentGainRef.current) {
      try {
        silentGainRef.current.disconnect();
      } catch {
        /* ignore */
      }
      silentGainRef.current = null;
    }
    if (sourceRef.current) {
      try {
        sourceRef.current.disconnect();
      } catch {
        /* ignore */
      }
      sourceRef.current = null;
    }
    const s = streamRef.current;
    if (s) {
      for (const t of s.getTracks()) t.stop();
    }
    streamRef.current = null;

    const ac = audioContextRef.current;
    if (ac && ac.state !== "closed") {
      ac.close().catch(() => {
        /* ignore */
      });
    }
    audioContextRef.current = null;

    if (interruptionTimerRef.current) {
      clearTimeout(interruptionTimerRef.current);
      interruptionTimerRef.current = null;
    }
  }, []);

  const stopCapture = useCallback(() => {
    if (
      !streamRef.current &&
      !audioContextRef.current &&
      !sourceRef.current &&
      !processorRef.current
    ) {
      return;
    }
    teardown();
    setStream(null);
    setAnalyserNode(null);
    setCurrentVolume(0);
    setIsCapturing(false);
  }, [teardown]);

  const startCapture = useCallback(async (): Promise<boolean> => {
    if (startingRef.current) return false;
    startingRef.current = true;

    if (streamRef.current || audioContextRef.current) {
      teardown();
      setStream(null);
      setAnalyserNode(null);
      setCurrentVolume(0);
      setIsCapturing(false);
    }

    setError(null);

    try {
      const newStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      streamRef.current = newStream;

      const audioContext = constructAudioContext();
      audioContextRef.current = audioContext;

      if (audioContext.state === "suspended") {
        await audioContext.resume();
      }

      const source = audioContext.createMediaStreamSource(newStream);
      sourceRef.current = source;

      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.8;
      source.connect(analyser);

      // Raw-PCM tap for the Scribe Realtime WebSocket. ScriptProcessor is
      // deprecated but works on every browser including iOS Safari; the
      // AudioWorklet replacement still has rough edges on older iOS.
      const processor = audioContext.createScriptProcessor(
        PROCESSOR_BUFFER,
        1,
        1,
      );
      processorRef.current = processor;

      const inputSampleRate = audioContext.sampleRate;
      processor.onaudioprocess = (event) => {
        const handler = pcmHandlerRef.current;
        if (!handler) return;
        const input = event.inputBuffer.getChannelData(0);
        const downsampled = downsampleTo16k(input, inputSampleRate);
        handler(floatToPcm16Base64(downsampled));
      };
      source.connect(processor);

      // ScriptProcessor only fires onaudioprocess once it's connected to a
      // destination. We must NOT let the mic audio actually reach the
      // speakers — route through a gain=0 node so the graph is "alive" but
      // silent.
      const silentGain = audioContext.createGain();
      silentGain.gain.value = 0;
      silentGainRef.current = silentGain;
      processor.connect(silentGain);
      silentGain.connect(audioContext.destination);

      audioContext.addEventListener("statechange", () => {
        const state = audioContext.state;
        console.log("[LINGO] AudioContext state:", state);
        if ((state as string) === "interrupted") {
          if (!interruptionTimerRef.current) {
            interruptionTimerRef.current = setTimeout(() => {
              console.log(
                "[LINGO] Extended interruption (>30s) — stopping session",
              );
              stopCapture();
            }, INTERRUPTION_TIMEOUT_MS);
          }
          return;
        }
        if (state === "running" && interruptionTimerRef.current) {
          clearTimeout(interruptionTimerRef.current);
          interruptionTimerRef.current = null;
        }
      });

      console.log(
        `[LINGO] AudioContext ready: sampleRate=${audioContext.sampleRate}Hz, downsample=${
          inputSampleRate === TARGET_SAMPLE_RATE ? "off" : `${inputSampleRate}→${TARGET_SAMPLE_RATE}`
        }`,
      );

      setStream(newStream);
      setAnalyserNode(analyser);
      setIsCapturing(true);
      return true;
    } catch (e) {
      const err = e as DOMException & { message?: string };
      const name = err.name;
      let message: string;
      if (name === "NotAllowedError") {
        message =
          "Microphone access denied. Please allow mic access in your browser settings.";
      } else if (name === "NotFoundError") {
        message = "No microphone found on this device.";
      } else {
        message = `Could not access microphone: ${err.message ?? "unknown error"}`;
      }
      setError(message);
      teardown();
      setStream(null);
      setAnalyserNode(null);
      setCurrentVolume(0);
      setIsCapturing(false);
      return false;
    } finally {
      startingRef.current = false;
    }
  }, [teardown, stopCapture]);

  // Volume RAF loop — reads the analyser, computes RMS, pushes to React
  // state at ~20 Hz. This used to live in useVAD; now it's here because the
  // capture hook owns the analyser and there's no VAD anymore.
  useEffect(() => {
    if (!isCapturing || !analyserNode) return;
    const dataArray = new Uint8Array(analyserNode.frequencyBinCount);
    let rafId: number | null = null;
    let lastStateUpdate = 0;

    const tick = () => {
      if (document.hidden) {
        rafId = null;
        return;
      }
      analyserNode.getByteFrequencyData(dataArray);
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        const n = dataArray[i] / 255;
        sum += n * n;
      }
      const rms = Math.sqrt(sum / dataArray.length);
      const vol = Math.min(rms * 2.5, 1);
      const now = performance.now();
      if (now - lastStateUpdate > VOLUME_STATE_THROTTLE_MS) {
        lastStateUpdate = now;
        setCurrentVolume(vol);
      }
      rafId = requestAnimationFrame(tick);
    };

    const handleVisibility = () => {
      if (!document.hidden && rafId === null) {
        rafId = requestAnimationFrame(tick);
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    rafId = requestAnimationFrame(tick);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [isCapturing, analyserNode]);

  // Periodic drift check (every 5 minutes) — iOS sometimes suspends a long-
  // idle AudioContext without telling us.
  useEffect(() => {
    if (!isCapturing) return;
    const interval = setInterval(() => {
      const ac = audioContextRef.current;
      if (!ac) return;
      if (ac.state === "suspended") {
        console.log("[LINGO] AudioContext drift (suspended) — resuming");
        ac.resume().catch(() => {
          /* ignore */
        });
      } else if (ac.state === "closed") {
        console.log("[LINGO] AudioContext drift (closed) — needs restart");
      }
    }, DRIFT_CHECK_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [isCapturing]);

  useEffect(() => {
    return () => {
      teardown();
    };
  }, [teardown]);

  return {
    isCapturing,
    stream,
    analyserNode,
    currentVolume,
    error,
    startCapture,
    stopCapture,
    setPCMHandler,
  };
}

export default useAudioCapture;
