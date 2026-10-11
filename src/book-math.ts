// Size-weighted book progress and whole-book runtime estimates. Chapter files are assumed to share
// a bitrate, so byte sizes map to time the same way src/hardcover-math.ts maps them for Hardcover.
// Pure: no React Native, Expo or storage imports, so the Node test runner can exercise it.

/** Fraction of a book listened to when every chapter is assumed to be the same length. */
function equalWeightFraction(index: number, position: number, duration: number, chapterCount: number, finished?: boolean): number {
  if (!chapterCount) return 0;
  if (finished) return 1;
  return Math.min(1, (index + (duration ? position / duration : 0)) / chapterCount);
}

/**
 * Fraction of a book listened to, weighting each chapter by its file size. Falls back to the old
 * equal-weight formula when the sizes are missing or unusable.
 */
export function sizeWeightedFraction(
  fileSizes: number[] | undefined,
  index: number,
  position: number,
  duration: number,
  chapterCount: number,
  finished?: boolean,
): number {
  if (!chapterCount) return 0;
  if (finished) return 1;
  const sizes = fileSizes ?? [];
  const total = sizes.reduce((a, b) => a + b, 0);
  const cur = sizes[index] ?? 0;
  if (total > 0 && cur > 0) {
    const before = sizes.slice(0, index).reduce((a, b) => a + b, 0);
    const within = duration > 0 ? Math.min(1, Math.max(0, position / duration)) : 0;
    return Math.min(1, (before + within * cur) / total);
  }
  return equalWeightFraction(index, position, duration, chapterCount, finished);
}

/**
 * Whole-book runtime in seconds: currentDuration x totalSize / currentSize. Null when it cannot be
 * estimated (no sizes, no current file size, or no duration yet).
 */
export function estimateBookSeconds(fileSizes: number[] | undefined, index: number, duration: number): number | null {
  const sizes = fileSizes ?? [];
  const total = sizes.reduce((a, b) => a + b, 0);
  const cur = sizes[index] ?? 0;
  if (!(duration > 0) || total <= 0 || cur <= 0) return null;
  return (duration * total) / cur;
}

/**
 * Estimated seconds still to go in the book, or null when there isn't enough information. Uses the
 * size-weighted position so it stays consistent with the progress bar.
 */
export function remainingBookSeconds(
  fileSizes: number[] | undefined,
  index: number,
  position: number,
  duration: number,
  chapterCount: number,
  finished?: boolean,
): number | null {
  const total = estimateBookSeconds(fileSizes, index, duration);
  if (total === null) return null;
  const frac = sizeWeightedFraction(fileSizes, index, position, duration, chapterCount, finished);
  return Math.max(0, total * (1 - frac));
}
