/**
 * Estimates seconds listened across the whole book. Chapter files are assumed to share a bitrate,
 * so byte offsets map to time. If Hardcover knows the edition's length, the fraction is scaled to it.
 */
export function listenedSeconds(fileSizes: number[], index: number, position: number, duration: number, editionSeconds?: number) {
  const total = fileSizes.reduce((a, b) => a + b, 0);
  const before = fileSizes.slice(0, index).reduce((a, b) => a + b, 0);
  const cur = fileSizes[index] || 0;
  const frac = duration > 0 ? Math.min(1, position / duration) : 0;
  if (editionSeconds && total > 0) return Math.round(((before + frac * cur) / total) * editionSeconds);
  const secPerByte = duration > 0 && cur > 0 ? duration / cur : 0;
  return Math.round(before * secPerByte + position);
}
