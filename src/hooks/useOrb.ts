"use client";

import { useCallback, useEffect, useRef } from "react";
import {
  BackSide,
  Color,
  Group,
  IcosahedronGeometry,
  Mesh,
  PerspectiveCamera,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  WebGLRenderer,
} from "three";

// Ashima / Stefan Gustavson 3D simplex noise (public domain, ~50 lines).
const GLSL_SIMPLEX_3D = /* glsl */ `
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);

  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);

  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);

  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;

  i = mod289(i);
  vec4 p = permute(permute(permute(
              i.z + vec4(0.0, i1.z, i2.z, 1.0))
            + i.y + vec4(0.0, i1.y, i2.y, 1.0))
            + i.x + vec4(0.0, i1.x, i2.x, 1.0));

  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;

  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);

  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);

  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);

  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);

  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));

  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;

  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);

  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x;
  p1 *= norm.y;
  p2 *= norm.z;
  p3 *= norm.w;

  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}
`;

const ORB_VERTEX_SHADER = /* glsl */ `
${GLSL_SIMPLEX_3D}

uniform float uTime;
uniform float uVolume;
uniform float uPulse;

varying vec3 vNormal;
varying vec3 vPosition;
varying float vDisplacement;

void main() {
  vNormal = normalize(normal);
  vPosition = position;

  // Slow, ambient breathing — visible even at silence.
  float baseNoise = snoise(position * 1.5 + uTime * 0.15) * 0.08;
  // Audio-reactive disturbance — faster + stronger with volume.
  float audioNoise = snoise(position * 3.0 + uTime * 0.5) * uVolume * 0.35;
  // Short-lived pulse displacement when a translation lands.
  float pulseNoise = snoise(position * 4.0 + uTime * 1.2) * uPulse * 0.25;

  float displacement = baseNoise + audioNoise + pulseNoise;
  vDisplacement = displacement;

  vec3 newPosition = position + normal * displacement;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(newPosition, 1.0);
}
`;

const ORB_FRAGMENT_SHADER = /* glsl */ `
${GLSL_SIMPLEX_3D}

uniform float uTime;
uniform float uVolume;
uniform vec3 uBaseColor;
uniform vec3 uAccentColor;

varying vec3 vNormal;
varying vec3 vPosition;
varying float vDisplacement;

void main() {
  vec3 viewDirection = normalize(cameraPosition - vPosition);
  float fresnel = pow(1.0 - clamp(dot(viewDirection, vNormal), 0.0, 1.0), 2.5);

  vec3 color = mix(uBaseColor, uAccentColor, fresnel * 0.7 + vDisplacement * 2.0);

  // Dramatic dark-core to bright-edge ramp (Dribbble-reference look):
  // centre stays ~35% brightness, silhouette gets the full brightness curve.
  float brightness = 0.6 + uVolume * 0.4;
  color *= brightness * (0.35 + fresnel * 0.65);

  // White-cyan rim light along the silhouette.
  color += vec3(0.7, 0.9, 1.0) * fresnel * 0.3;

  // Sharp, faint blue-white veins — peaked noise so values cluster near zero
  // and only the highest noise ridges produce visible streaks.
  float veinNoise = pow(abs(snoise(vPosition * 8.0 + uTime * 0.1)), 3.0);
  color += vec3(0.3, 0.5, 0.8) * veinNoise * 0.15 * (0.5 + fresnel);

  // Inner glow brighter toward the centre.
  float innerGlow = 1.0 - fresnel;
  color += uBaseColor * innerGlow * 0.15;

  gl_FragColor = vec4(color, 0.95);
}
`;

const GLOW_VERTEX_SHADER = /* glsl */ `
varying vec3 vNormal;
void main() {
  vNormal = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const GLOW_FRAGMENT_SHADER = /* glsl */ `
uniform vec3 uColor;
uniform float uVolume;
varying vec3 vNormal;
void main() {
  float intensity = pow(0.65 - dot(vNormal, vec3(0.0, 0.0, 1.0)), 2.0);
  float alpha = intensity * (0.15 + uVolume * 0.25);
  gl_FragColor = vec4(uColor, alpha);
}
`;

export interface UseOrbOptions {
  useMockData?: boolean;
  reducedMotion?: boolean;
}

export interface UseOrbResult {
  containerRef: React.RefObject<HTMLDivElement | null>;
  setVolume: (v: number) => void;
  triggerPulse: () => void;
}

const PULSE_DURATION_MS = 300;
const LERP_FACTOR = 0.08;

export function useOrb({
  useMockData = false,
  reducedMotion = false,
}: UseOrbOptions = {}): UseOrbResult {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number | null>(null);

  const targetVolumeRef = useRef(0);
  const currentVolumeRef = useRef(0);
  const pulseStartRef = useRef<number | null>(null);

  // Mock state — only drives the orb until the first external setVolume().
  const lastMockPulseRef = useRef(0);
  const mockSpikeUntilRef = useRef(0);
  const receivingExternalDataRef = useRef(false);

  const setVolume = useCallback((v: number) => {
    targetVolumeRef.current = Math.max(0, Math.min(1, v));
    receivingExternalDataRef.current = true;
  }, []);

  const triggerPulse = useCallback(() => {
    pulseStartRef.current = performance.now();
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    // Re-bind through an explicit non-null local so narrowing survives into
    // the nested arrow functions below.
    const host: HTMLDivElement = container;

    const renderer = new WebGLRenderer({
      alpha: true,
      antialias: true,
      powerPreference: "high-performance",
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 0);
    renderer.setSize(host.clientWidth, host.clientHeight);
    host.appendChild(renderer.domElement);

    const scene = new Scene();
    const camera = new PerspectiveCamera(
      45,
      host.clientWidth / host.clientHeight,
      0.1,
      100,
    );
    // At fov=45° with orb radius=1: projected orb height =
    //   2 / (2 * z * tan(22.5°))  of the viewport.
    // z=4 → ~60% (overpowers the screen).
    // z=6.5 → ~37% (still dominant).
    // z=9.5 → ~25% (the Dribbble-reference proportion — floating object
    //               with generous dark space).
    camera.position.set(0, 0, 9.5);

    // Geometry detail: 64 vertices per icosahedron face on full motion mode,
    // 24 under prefers-reduced-motion (still smooth, ~5.8k vertices).
    const detail = reducedMotion ? 24 : 64;
    const orbGeometry = new IcosahedronGeometry(1, detail);
    const orbMaterial = new ShaderMaterial({
      transparent: true,
      vertexShader: ORB_VERTEX_SHADER,
      fragmentShader: ORB_FRAGMENT_SHADER,
      uniforms: {
        uTime: { value: 0 },
        uVolume: { value: 0 },
        uPulse: { value: 0 },
        uBaseColor: { value: new Color(0x00d4aa) },
        uAccentColor: { value: new Color(0x6366f1) },
      },
    });
    const orbMesh = new Mesh(orbGeometry, orbMaterial);

    const glowGeometry = new SphereGeometry(1.4, 32, 32);
    const glowMaterial = new ShaderMaterial({
      transparent: true,
      side: BackSide,
      vertexShader: GLOW_VERTEX_SHADER,
      fragmentShader: GLOW_FRAGMENT_SHADER,
      uniforms: {
        uColor: { value: new Color(0x00d4aa) },
        uVolume: { value: 0 },
      },
    });
    const glowMesh = new Mesh(glowGeometry, glowMaterial);

    const group = new Group();
    group.add(glowMesh);
    group.add(orbMesh);
    scene.add(group);

    const resize = () => {
      const w = host.clientWidth;
      const h = host.clientHeight;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };

    const loop = (now: number) => {
      if (document.hidden) {
        rafRef.current = null;
        return;
      }

      // Mock data while no external setVolume() has fired yet.
      if (useMockData && !receivingExternalDataRef.current) {
        const base = Math.sin(now * 0.001) * 0.3 + 0.3;
        if (now - lastMockPulseRef.current > 4000) {
          lastMockPulseRef.current = now;
          mockSpikeUntilRef.current = now + 500;
          pulseStartRef.current = now;
        }
        const spike = now < mockSpikeUntilRef.current ? 0.4 : 0;
        targetVolumeRef.current = Math.min(1, base + spike);
      }

      // Lerp the displayed volume so the surface never snaps.
      currentVolumeRef.current +=
        (targetVolumeRef.current - currentVolumeRef.current) * LERP_FACTOR;

      orbMaterial.uniforms.uTime.value = now * 0.001;
      orbMaterial.uniforms.uVolume.value = currentVolumeRef.current;
      glowMaterial.uniforms.uVolume.value = currentVolumeRef.current;

      // Pulse decay (ease-out quadratic).
      if (pulseStartRef.current !== null) {
        const elapsed = now - pulseStartRef.current;
        if (elapsed >= PULSE_DURATION_MS) {
          pulseStartRef.current = null;
          orbMaterial.uniforms.uPulse.value = 0;
        } else {
          const t = Math.max(0, Math.min(1, elapsed / PULSE_DURATION_MS));
          const remaining = 1 - t;
          orbMaterial.uniforms.uPulse.value = remaining * remaining;
        }
      }

      // Rotation — faster when speaking.
      if (!reducedMotion) {
        const speedMult = 1 + currentVolumeRef.current * 0.5;
        orbMesh.rotation.y += 0.002 * speedMult;
        orbMesh.rotation.x += 0.001 * speedMult;
      }

      // Subtle zero-g float on the whole group.
      group.position.y = Math.sin(now * 0.0005) * 0.12;

      renderer.render(scene, camera);
      rafRef.current = requestAnimationFrame(loop);
    };

    const handleVisibility = () => {
      if (!document.hidden && rafRef.current === null) {
        rafRef.current = requestAnimationFrame(loop);
      }
    };

    window.addEventListener("resize", resize);
    document.addEventListener("visibilitychange", handleVisibility);
    rafRef.current = requestAnimationFrame(loop);

    return () => {
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", handleVisibility);
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      orbGeometry.dispose();
      orbMaterial.dispose();
      glowGeometry.dispose();
      glowMaterial.dispose();
      renderer.dispose();
      try {
        host.removeChild(renderer.domElement);
      } catch {
        /* renderer.domElement was already detached */
      }
    };
  }, [useMockData, reducedMotion]);

  return { containerRef, setVolume, triggerPulse };
}

export default useOrb;
