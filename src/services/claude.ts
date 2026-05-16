// Claude fallback translator. Called only when Whisper translate returns
// empty/garbage and we already have Assamese text from Whisper transcribe.

const MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-20250514";

const SYSTEM_PROMPT = `You are a translator. You receive Assamese (অসমীয়া) text transcribed from live speech. Translate it to natural, fluent, conversational English.

Rules:
- Return ONLY the English translation, nothing else
- No quotes, no explanation, no preamble, no "Translation:" prefix
- The text is typically in Assamese script but may occasionally contain Bengali or other similar scripts due to transcription errors — translate the intended meaning regardless
- If the text is already in English, return it unchanged
- If the text is unclear or fragmentary, make your best attempt at the meaning
- Preserve the tone (casual, formal, emotional) of the original
- Keep names and proper nouns as-is
- This is real-time conversation, so keep translations natural and conversational`;

interface ContentBlock {
  type: string;
  text?: string;
}

interface ClaudeMessageResponse {
  content?: ContentBlock[];
}

export async function translateWithClaude(
  assameseText: string,
  signal?: AbortSignal,
): Promise<string> {
  const apiKey = process.env.NEXT_PUBLIC_ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("NEXT_PUBLIC_ANTHROPIC_API_KEY is not set");

  const response = await fetch(MESSAGES_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      // Required to call the Messages API directly from a browser. Fine for
      // personal use; if this app ever ships behind auth, move calls to a
      // server route and drop this header.
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 500,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: assameseText }],
    }),
    signal,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "unknown");
    throw new Error(`Claude API error ${response.status}: ${body}`);
  }

  const data = (await response.json()) as ClaudeMessageResponse;
  const text = (data.content ?? [])
    .filter(
      (block): block is ContentBlock & { text: string } =>
        block.type === "text" && typeof block.text === "string",
    )
    .map((block) => block.text)
    .join(" ")
    .trim();

  // If Claude returns nothing, pass through the original Assamese so the
  // segment isn't completely lost. Better than silently dropping it.
  return text || assameseText;
}
