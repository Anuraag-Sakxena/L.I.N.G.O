// ElevenLabs Scribe v2 Realtime — WebSocket-based streaming STT.
//
// Pipeline shape:
//   raw PCM frames (16-bit, 16kHz, mono, base64) → sendAudio()
//                                                 ↓
//                                       Scribe server VADs + segments
//                                                 ↓
//             onPartialTranscript("...")  ← partial_transcript messages
//             onCommittedTranscript("...") ← committed_transcript / *_with_timestamps
//
// Docs: https://elevenlabs.io/docs/api-reference/speech-to-text/realtime

const ENDPOINT = "wss://api.elevenlabs.io/v1/speech-to-text/realtime";
const TOKEN_ENDPOINT =
  "https://api.elevenlabs.io/v1/single-use-token/realtime_scribe";
const MODEL_ID = "scribe_v2_realtime";
// ISO 639-3 — ElevenLabs uses 3-letter codes. "as" is Whisper's convention
// and is NOT valid here.
const DEFAULT_LANGUAGE = "asm";
const DEFAULT_SAMPLE_RATE = 16_000;
const DEFAULT_VAD_SILENCE_SECS = 1.0;

export interface ScribeRealtimeConfig {
  apiKey: string;
  languageCode?: string;
  sampleRate?: number;
  vadSilenceThreshold?: number;
  onPartialTranscript: (text: string) => void;
  onCommittedTranscript: (text: string, languageCode?: string) => void;
  onError: (error: string) => void;
  onSessionStarted: (sessionId: string) => void;
  onDisconnected: () => void;
}

interface ScribeMessage {
  message_type?: string;
  text?: string;
  session_id?: string;
  language_code?: string;
  [key: string]: unknown;
}

interface TokenResponse {
  token?: string;
}

// Browser WebSockets can't set headers, so `xi-api-key` only works on REST.
// Mint a short-lived token here and pass it on the WS URL as `?token=…`.
async function fetchScribeToken(apiKey: string): Promise<string> {
  // The `realtime_scribe` path parameter scopes the token to the Scribe v2
  // Realtime WS. No request body — only the API key in the header.
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
    },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "unknown");
    throw new Error(`ElevenLabs token error ${response.status}: ${body}`);
  }
  const data = (await response.json()) as TokenResponse;
  if (!data.token) {
    throw new Error("ElevenLabs token endpoint returned no token");
  }
  return data.token;
}

export class ScribeRealtimeConnection {
  private ws: WebSocket | null = null;
  private disposed = false;
  private readonly config: ScribeRealtimeConfig;
  private readonly sampleRate: number;

  constructor(config: ScribeRealtimeConfig) {
    this.config = config;
    this.sampleRate = config.sampleRate ?? DEFAULT_SAMPLE_RATE;
  }

  async connect(): Promise<void> {
    if (this.ws) {
      console.warn("[LINGO] Scribe connect() called with an active socket");
      return;
    }
    this.disposed = false;

    // Step 1 — fetch a single-use token. The realtime endpoint will not
    // accept `xi-api-key` as a query param; only the token works for
    // browser-side WS auth.
    let token: string;
    try {
      token = await fetchScribeToken(this.config.apiKey);
      console.log("[LINGO] Scribe token acquired");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[LINGO] Failed to acquire Scribe token: ${msg}`);
      this.config.onError("Failed to authenticate with ElevenLabs");
      // Signal "this connection instance is dead" so the orchestrator
      // can drop its ref and a retry can create a fresh one.
      this.config.onDisconnected();
      return;
    }

    // Re-check disposal between the await above and the WS construction —
    // the caller may have invoked disconnect() while we were fetching.
    if (this.disposed) return;

    const params = new URLSearchParams({
      model_id: MODEL_ID,
      language_code: this.config.languageCode ?? DEFAULT_LANGUAGE,
      audio_format: `pcm_${this.sampleRate}`,
      commit_strategy: "vad",
      vad_silence_threshold_secs: String(
        this.config.vadSilenceThreshold ?? DEFAULT_VAD_SILENCE_SECS,
      ),
      include_timestamps: "false",
      include_language_detection: "true",
      token,
    });

    const url = `${ENDPOINT}?${params.toString()}`;

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      this.config.onError(
        `WebSocket construct failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.config.onDisconnected();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      console.log("[LINGO] Scribe WebSocket connected");
    };

    ws.onmessage = (event) => {
      if (this.disposed) return;
      let msg: ScribeMessage;
      try {
        msg = JSON.parse(typeof event.data === "string" ? event.data : "");
      } catch {
        return;
      }
      const type = msg.message_type ?? "";

      switch (type) {
        case "session_started":
          console.log(`[LINGO] Scribe session: ${msg.session_id ?? "?"}`);
          this.config.onSessionStarted(msg.session_id ?? "");
          return;

        case "partial_transcript":
          if (typeof msg.text === "string") {
            this.config.onPartialTranscript(msg.text);
          }
          return;

        case "committed_transcript": {
          const text = (msg.text ?? "").trim();
          const lang = msg.language_code;
          if (text) {
            console.log(
              `[LINGO] Scribe committed${lang ? ` (${lang})` : ""} → "${text}"`,
            );
            this.config.onCommittedTranscript(text, lang);
          }
          return;
        }

        case "committed_transcript_with_timestamps":
          // INTENTIONALLY IGNORED. ElevenLabs emits this alongside the
          // plain `committed_transcript` for every utterance, even when
          // include_timestamps=false. Processing both produces duplicate
          // segments in both panels.
          return;

        default:
          if (type.toLowerCase().includes("error")) {
            console.error(`[LINGO] Scribe error: ${type}`, msg);
            this.config.onError(type);
          }
      }
    };

    ws.onerror = () => {
      // The Event object here is intentionally opaque per the WebSocket spec —
      // the real reason (if any) arrives in the subsequent onclose.
      console.error("[LINGO] Scribe WebSocket error event");
      this.config.onError("WebSocket connection error");
    };

    ws.onclose = (event) => {
      const reason = event.reason || "(no reason)";
      console.log(
        `[LINGO] Scribe WebSocket closed: code=${event.code} reason="${reason}"`,
      );
      this.ws = null;
      this.config.onDisconnected();
    };
  }

  sendAudio(pcmBase64: string): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(
      JSON.stringify({
        message_type: "input_audio_chunk",
        audio_base_64: pcmBase64,
        sample_rate: this.sampleRate,
      }),
    );
  }

  disconnect(): void {
    this.disposed = true;
    const ws = this.ws;
    if (!ws) return;
    try {
      if (
        ws.readyState === WebSocket.OPEN ||
        ws.readyState === WebSocket.CONNECTING
      ) {
        ws.close(1000, "client_disconnect");
      }
    } catch {
      /* ignore */
    }
    this.ws = null;
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}
