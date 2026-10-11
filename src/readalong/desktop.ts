// Renderer-side access to the desktop (Electron) read-along runner.
//
// The Electron shell exposes the `readalong` bridge on `window.earmarkDesktop` (see
// desktop/preload.js); on the phone or web export that object is absent, so
// `readalongBridge()` returns null and callers can fall back to another path.
//
// No react-native/expo imports: this file is pure TypeScript so it can be used by the
// web build and tested with plain Node.

/** Progress events emitted by `readalong.py --progress-json` (see tools/readalong/README.md). */
export type ReadalongEvent =
  | { event: 'start'; files: number; clips: number }
  | { event: 'download'; file: number; bytes: number; total: number }
  | { event: 'clip'; done: number; total: number; t: number; file: number; transcribed: boolean }
  | {
      event: 'done';
      out: string;
      clips: number;
      matched: number;
      kept: number;
      wpm_median: number | null;
    }
  | { event: 'error'; message: string };

/** One `time -> paragraph` anchor from anchors.json; `t` is the word start within the file. */
export type ReadalongAnchor = {
  t: number;
  para: number;
  word: number;
  conf: number;
};

export type ReadalongFile = {
  id: number;
  name: string;
  duration: number | null;
  anchors: ReadalongAnchor[];
  /** Xing/VBR seek map for a single Xing MP3; opaque here, validated by fromAnchorsJson. */
  seek?: unknown;
};

/** The parsed `anchors.json` produced by the tool. It contains no book text. */
export type ReadalongAnchorsJson = {
  version: number;
  timing?: string;
  hash: string;
  epub: {
    title: string;
    paragraphs: number;
    words: number;
    source: 'epub' | 'paragraphs';
    paragraphsSha1: string;
  };
  files: ReadalongFile[];
};

export type ReadalongStatus = {
  available: boolean;
  reason?: string;
  python: string;
  script: string;
};

export type ReadalongRunOptions = {
  hash: string;
  fileIds: number[];
  title: string;
  paragraphs: string[];
};

export type ReadalongBridge = {
  status(): Promise<ReadalongStatus>;
  /** Bytes of the EPUB saved for this audio hash, or null when there is none on disk yet. */
  readEpub(hash: string): Promise<Uint8Array | null>;
  /** Downloads the EPUB to the app's data directory and returns its bytes. */
  fetchEpub(url: string, hash: string): Promise<Uint8Array>;
  /** Runs the whole job; resolves with anchors.json. Events arrive via `onEvent`. */
  run(opts: ReadalongRunOptions): Promise<ReadalongAnchorsJson>;
  cancel(): Promise<unknown>;
  /** Subscribe to progress events; returns an unsubscribe function. */
  onEvent(cb: (event: ReadalongEvent) => void): () => void;
};

/** The desktop read-along bridge, or null when not running inside the Electron shell. */
export function readalongBridge(): ReadalongBridge | null {
  const bridge = (globalThis as { earmarkDesktop?: { readalong?: ReadalongBridge } })
    .earmarkDesktop?.readalong;
  return bridge ?? null;
}
