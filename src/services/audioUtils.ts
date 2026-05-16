// Audio blob helpers used by the capture + translation pipeline.

export function blobToFile(blob: Blob, filename: string): File {
  return new File([blob], filename, { type: blob.type });
}

export function combineChunks(chunks: Blob[], mimeType: string): Blob {
  return new Blob(chunks, { type: mimeType });
}

export function getExtensionForMime(mimeType: string): string {
  if (mimeType.includes("webm")) return "webm";
  if (mimeType.includes("mp4")) return "mp4";
  if (mimeType.includes("ogg")) return "ogg";
  return "webm";
}

// Rough duration estimate from blob size. Assumes opus ≈ 32 kbps = 4 KB/s.
// Not precise — for logging / UI hints only.
export function estimateDuration(blob: Blob): number {
  const bytesPerSecond = 4000;
  return (blob.size / bytesPerSecond) * 1000;
}
