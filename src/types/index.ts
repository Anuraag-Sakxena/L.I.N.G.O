export type TranslationSource = "whisper-direct" | "claude-fallback";

export interface TranslationSegment {
  id: string;
  englishText: string;
  assameseText?: string;
  timestamp: Date;
  source: TranslationSource;
}

export type AppStatus = "idle" | "listening" | "translating" | "error";
