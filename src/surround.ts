// JavaScript bridge to the Android-only `EarmarkSurround` Expo module, which owns the AC-3 / Dolby
// Digital passthrough audio sink. Web, desktop and any Android build without the module get `null`
// from `requireOptionalNativeModule`, so every function here is a safe no-op there.
import { requireOptionalNativeModule } from 'expo';

type SurroundModule = {
  /** The path the most recently configured sink chose. */
  outputMode(): string;
  /** Whether the sink may encode to AC-3; read at the next configure. */
  setSurroundEnabled(enabled: boolean): void;
};

// The lookup itself is guarded so a missing or broken module can never crash the caller.
let native: SurroundModule | null = null;
try {
  native = requireOptionalNativeModule<SurroundModule>('EarmarkSurround');
} catch {
  native = null;
}

/** Whether the native surround module is present (Android builds that ship it). */
export function surroundSupported(): boolean {
  return native != null;
}

/** Turns the AC-3 path on or off. Applies at the next sink configure. */
export function setSurroundEnabled(enabled: boolean): void {
  try { native?.setSurroundEnabled(enabled); } catch { /* no-op */ }
}

/** The sink's current path, or 'idle' when the module is absent or the call fails. */
export function outputMode(): 'ac3' | 'pcm' | 'idle' {
  try {
    const mode = native?.outputMode();
    return mode === 'ac3' || mode === 'pcm' ? mode : 'idle';
  } catch {
    return 'idle';
  }
}
