export interface AssameseSegment {
  id: string;
  text: string;
  timestamp: Date;
}

export interface EnglishTranslation {
  /** Matches the AssameseSegment that produced it. */
  id: string;
  text: string;
  timestamp: Date;
}

export type AppStatus = "idle" | "listening" | "translating" | "error";
