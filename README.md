# LINGO

**L**anguage **I**'ll **N**ever **G**enuinely **O**btain — a personal-use PWA that listens to live Assamese speech and shows English translations on screen as subtitles. Two states: tap the orb, see translations appear. Tap End Session, done.

Not a general translation app. One screen, one person, one phone.

## Stack

- **Next.js 16** (App Router, TypeScript, Turbopack)
- **Tailwind CSS v4** (CSS-based `@theme` config)
- **Three.js** for the audio-reactive orb (custom GLSL shaders, no R3F)
- **Framer Motion** for UI animation
- **Zustand** for state
- **Web Audio API** for mic capture + VAD
- **Groq Whisper API** for Assamese → English translation (language hard-locked to `as`)
- **Claude Sonnet** as fallback translator when Whisper translate returns empty/hallucinated text
- Hand-rolled service worker (no workbox)

## Setup

```bash
npm install
cp .env.local.example .env.local
# Fill in NEXT_PUBLIC_GROQ_API_KEY + NEXT_PUBLIC_ANTHROPIC_API_KEY
npm run dev
```

Open http://localhost:3000.

## Architecture

```
src/
├── app/
│   ├── layout.tsx              # Root, PWA meta, Splash + SW registrar
│   ├── page.tsx                # Orb-as-button, panel choreography, error overlay
│   └── globals.css             # Tailwind v4 theme tokens, space-bg + starfield
│
├── components/
│   ├── Orb.tsx                 # Three.js orb (uses useOrb)
│   ├── SpaceBackground.tsx     # Radial gradient + 130 deterministic stars
│   ├── TranslationPanel.tsx    # Glass panel: timer, cards, End Session
│   ├── TranslationCard.tsx     # Individual segment card
│   ├── ConnectivityIndicator.tsx
│   ├── Splash.tsx              # SSR splash that fades on hydration
│   └── ServiceWorkerRegistrar.tsx
│
├── hooks/
│   ├── useAudioCapture.ts      # getUserMedia + AudioContext + statechange
│   ├── useVAD.ts               # RMS amplitude + 4-state speech machine + MediaRecorder
│   ├── useTranslation.ts       # Pipeline + queue + hallucination + repetition + abort
│   └── useOrb.ts               # Three.js scene + custom shaders + RAF loop
│
├── services/
│   ├── groq.ts                 # Whisper translate + transcribe (language: "as" forced)
│   ├── claude.ts               # Fallback translator
│   └── audioUtils.ts           # Blob ↔ File + duration estimation helpers
│
├── stores/
│   └── sessionStore.ts         # Zustand: segments, status, online, etc.
│
└── types/
    └── index.ts                # TranslationSegment, AppStatus, TranslationSource
```

## Translation pipeline

```
mic → AnalyserNode + MediaRecorder
    → VAD (RMS, hysteresis 0.15/0.08, 300ms speech / 700ms silence delays)
    → audio Blob
    → Groq Whisper translate (language: "as" forced)
       ├── good text   → segment (source: whisper-direct)
       ├── empty / hallucination / repetition / network error
       │                 ↓
       │              Groq Whisper transcribe (language: "as")
       │                 ↓
       │              Claude Sonnet translate
       │                 ↓
       │              segment (source: claude-fallback)
       └── transcribe or Claude fail → chunk skipped
```

## Non-negotiables

1. Whisper `language: "as"` is hard-locked. Auto-detect mis-identifies Assamese as Bengali.
2. No backend. API keys live in `NEXT_PUBLIC_*` env vars (personal use only).
3. iOS Safari is the primary target.
4. The orb IS the interface. Dormant state has zero chrome.

## Deploy

```bash
vercel --prod
```

Set `NEXT_PUBLIC_GROQ_API_KEY` and `NEXT_PUBLIC_ANTHROPIC_API_KEY` in the Vercel project's Environment Variables (Production, and Preview if you want preview builds to work). Bump `CACHE_NAME` in `public/sw.js` for each deploy so users who installed the previous version don't get stuck on cached assets.

## Why "personal use only"

The app calls Groq and Anthropic APIs directly from the browser using `NEXT_PUBLIC_*` keys. Anyone who opens DevTools can read them. Fine for one user with their own keys; do not deploy this publicly with shared keys. To make it multi-user, move both API calls to a server route or edge function and authenticate.
