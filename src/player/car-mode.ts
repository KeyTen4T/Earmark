// Pure helpers for the car-mode screen: the chapter line under the title and the current file's
// progress and remaining time. No react-native/expo imports, so the Node test runner covers it
// (test/car-mode.test.ts); the screen itself is src/screens/CarMode.tsx.

/** Progress through the current file for the non-interactive bar, clamped to 0..1 (0 with no duration). */
export function carProgress(position: number, duration: number): number {
  if (!(duration > 0)) return 0;
  return Math.max(0, Math.min(1, (position || 0) / duration));
}

/** Seconds left in the current file, never negative. */
export function carRemaining(position: number, duration: number): number {
  return Math.max(0, (duration || 0) - (position || 0));
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * The second line of the car screen: "Chapter x of n", with the chapter's own name appended when it
 * says something the book title doesn't, so a titled chapter is not lost in car mode.
 */
export function carChapterLine(chapterIndex: number, chapterCount: number, chapterName: string, displayTitle: string): string {
  const base = `Chapter ${chapterIndex + 1} of ${chapterCount}`;
  const name = (chapterName || '').trim();
  if (!name || norm(name) === norm(displayTitle || '')) return base;
  return `${base} · ${name}`;
}
