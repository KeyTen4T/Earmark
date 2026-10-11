// Pure parsing for stored JSON values. Kept out of storage.ts (which pulls in React Native) so the
// Node test runner can cover the corrupt-vs-missing decision.

/**
 * Parses a stored JSON string. A missing value (null or empty) yields the fallback and is not
 * corruption; a present value that fails to parse is corruption, which the caller keeps a copy of
 * before anything overwrites it.
 */
export function parseStored<T>(raw: string | null, fallback: T): { value: T; corrupt: boolean } {
  if (!raw) return { value: fallback, corrupt: false };
  try { return { value: JSON.parse(raw) as T, corrupt: false }; }
  catch { return { value: fallback, corrupt: true }; }
}
