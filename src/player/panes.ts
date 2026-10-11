// Which content the wide desktop player shows beside its controls (the second pane), and whether it
// splits into two panes at all. Pure: no react-native/expo imports, so the Node test runner can
// exercise it (test/panes.test.ts) like visibility.ts and book-math.ts.

/** The chapter list, or the read-along text, filling the player's content pane. */
export type RightPane = 'chapters' | 'text';

export type PlayerPanes = {
  /** True when the wide player splits into a controls pane and a content pane. */
  twoPane: boolean;
  /** What the content pane holds, or null when there is no second pane. */
  right: RightPane | null;
  /**
   * A one-file book with a read-along keeps its text in the pane: there is no chapter list to go
   * back to, so the Read toggle would leave the pane empty.
   */
  textFixed: boolean;
};

/**
 * Decide the wide player's pane layout. The phone layout never splits, so `twoPane` is false
 * whenever `wide` is false. A one-file book with no read-along has nothing worth a second pane and
 * stays a single centred column. Otherwise the pane shows the chapter list, or the read-along text
 * when Read is on — always, for a one-file book.
 */
export function playerPanes({ wide, chapterCount, hasReadalong, showText }: {
  wide: boolean; chapterCount: number; hasReadalong: boolean; showText: boolean;
}): PlayerPanes {
  if (!wide) return { twoPane: false, right: null, textFixed: false };
  const textFixed = hasReadalong && chapterCount <= 1;
  if (!hasReadalong && chapterCount <= 1) return { twoPane: false, right: null, textFixed: false };
  return { twoPane: true, right: hasReadalong && (showText || textFixed) ? 'text' : 'chapters', textFixed };
}
