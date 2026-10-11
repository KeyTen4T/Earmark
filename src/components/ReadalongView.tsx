// The read-along reading panel shown inside the player, in place of the artwork and title block.
// It shows the EPUB the anchors were built from, highlights the paragraph being read, follows the
// audio as it plays, and seeks when a paragraph is tapped. The book text is never stored in the
// synced record: it is read from a local copy of the EPUB (see src/readalong/source.ts).
//
// The list renders only a moving slice of the book (see src/readalong/window.ts): while following,
// the slice is centred so the current paragraph sits ~30 rows from the top; while the reader browses
// by hand it is only ever *grown* toward the edge they reach, so no row is pulled out from under the
// scroll offset (re-centring there raced the viewport through the book and left it blank).
// Following uses *measured* row offsets (each row's content-relative y, captured via a
// CellRendererComponent) rather than `scrollToIndex`, whose estimated frames land wrong on a fresh
// window after a big seek.
//
// Works on the phone and in the desktop app's centred player column.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, AppState, FlatList, Platform, Text, View, type ViewToken } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { C, R, T } from '../theme';
import { Button, Tap } from './ui';
import { locate, paragraphStartWord, timeForWord, type ReadalongRecord } from '../readalong/anchors';
import { extrapolatePosition, type PositionClock } from '../player/position';
import { loadParagraphs, type ParagraphSource } from '../readalong/source';
import { computeWindow, shouldRecentre, growWindow, type WindowRange } from '../readalong/window';

const SERIF = Platform.select({ android: 'serif', ios: 'Georgia', default: 'Georgia, "Times New Roman", serif' });
const FOLLOW_RESUME_MS = 10_000;
const CURRENT_VIEW_POSITION = 0.33; // keep the current paragraph about a third from the top
// Look this far ahead of playback so a paragraph highlights as the narrator starts it.
const HIGHLIGHT_LEAD_SECONDS = 0.3;
// Recompute the highlight faster than the player's status updates; the clock is extrapolated.
const HIGHLIGHT_TICK_MS = 250;
// Any scroll within this long of a programmatic scroll is treated as ours, not the reader's.
const PROGRAMMATIC_MS = 1000;
const INITIAL_RENDER = 40; // covers the ~30 rows above the current paragraph in a fresh window
const EMPTY_WINDOW: WindowRange = { start: 0, end: 0 };

type Phase = 'loading' | 'downloading' | 'ready' | 'error';
/** One rendered row, carrying its absolute paragraph index for the highlight and tap-to-seek. */
type Row = { text: string; index: number };
type PendingScroll = { index: number; viewPosition: number };

export function ReadalongView({ audioHash, record, fileId, clock, onSeek, onManage, chromeHidden = false, canSeek, onChipTouch }: {
  /** The audiobook's info-hash: the local EPUB copy is stored under it. */
  audioHash: string;
  record: ReadalongRecord;
  fileId: number;
  /** Enough player state to estimate the current position between status updates. */
  clock: PositionClock;
  onSeek: (seconds: number) => void;
  onManage?: () => void;
  /** Immersive reading: collapse this view's own header row and the mismatch banner. */
  chromeHidden?: boolean;
  /** Consulted before a paragraph tap seeks; returns false for the tap that reveals the chrome. */
  canSeek?: () => boolean;
  /** Fires when a touch starts on the "Back to current" chip, before the player's own root handler. */
  onChipTouch?: () => void;
}) {
  const [source, setSource] = useState<ParagraphSource | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState('');
  const [current, setCurrent] = useState<{ para: number; word: number } | null>(null);
  const [located, setLocated] = useState(false);
  const [follow, setFollow] = useState(true);
  const [win, setWin] = useState<WindowRange>(EMPTY_WINDOW);
  const [appActive, setAppActive] = useState(AppState.currentState !== 'background');

  const listRef = useRef<FlatList<Row>>(null);
  const clockRef = useRef(clock);
  clockRef.current = clock;
  const followTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const programmaticUntil = useRef(0);

  // Measured content-relative y for each rendered row, keyed by absolute paragraph index.
  const rowY = useRef(new Map<number, number>());
  const viewportH = useRef(0);
  const pending = useRef<PendingScroll | null>(null);
  const lastOffset = useRef(-1);
  // Browsing growth: the reader's live offset and the content height, a one-shot guard so only one
  // grow is applied until the new slice has rendered, and — on the web, which has no native
  // maintainVisibleContentPosition — the content height before rows were prepended above, so
  // onContentSizeChange can hold the view in place.
  const scrollOffset = useRef(0);
  const contentH = useRef(0);
  const growLock = useRef(false);
  const prependFrom = useRef<{ height: number; offset: number } | null>(null);

  // Stable snapshots for the FlatList callbacks, which must not change identity between renders.
  const sourceRef = useRef(source); sourceRef.current = source;
  const winRef = useRef(win); winRef.current = win;
  const followRef = useRef(follow); followRef.current = follow;
  const currentRef = useRef(current); currentRef.current = current;

  const hasAnchors = useMemo(
    () => !!record.files.find((f) => f.id === fileId && f.anchors.length > 0),
    [record, fileId],
  );

  const rows = useMemo<Row[]>(() => {
    if (!source) return [];
    const out: Row[] = [];
    for (let i = win.start; i < win.end && i < source.paragraphs.length; i++) out.push({ text: source.paragraphs[i], index: i });
    return out;
  }, [source, win]);

  const load = useCallback(() => {
    // A file that was never part of the build has no anchors: there is nothing to read along to, so
    // don't download the EPUB just to show the message.
    if (!hasAnchors) { setSource(null); setError(''); setPhase('ready'); return () => {}; }
    let cancelled = false;
    setPhase('loading');
    setError('');
    setCurrent(null);
    setLocated(false);
    setWin(EMPTY_WINDOW);
    rowY.current.clear();
    pending.current = null;
    lastOffset.current = -1;
    prependFrom.current = null;
    growLock.current = false;
    loadParagraphs(audioHash, record, () => { if (!cancelled) setPhase('downloading'); })
      .then((s) => { if (!cancelled) { setSource(s); setPhase('ready'); } })
      .catch((e: unknown) => {
        if (cancelled) return;
        setSource(null);
        setError(e instanceof Error ? e.message : 'Could not open the EPUB.');
        setPhase('error');
      });
    return () => { cancelled = true; };
  }, [audioHash, record, hasAnchors]);

  useEffect(() => {
    const cancel = load();
    return () => { cancel(); };
  }, [load]);

  // Ignore the layout scroll events that follow the list appearing.
  useEffect(() => {
    if (phase !== 'ready') return;
    programmaticUntil.current = Date.now() + PROGRAMMATIC_MS;
  }, [phase]);

  // Immersive reading collapses this view's header (and the player's chrome), which resizes the
  // list. A resize can make the native scroll emit a scroll event; treat it as ours so it does not
  // flip follow mode off while the list repositions itself.
  useEffect(() => {
    programmaticUntil.current = Date.now() + PROGRAMMATIC_MS;
  }, [chromeHidden]);

  // Track visibility: the highlight tick re-renders the list, which is wasted when nothing is drawn.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => setAppActive(next !== 'background'));
    return () => sub.remove();
  }, []);

  // The paragraph under the playhead, recomputed every 250 ms from an extrapolated position (not on
  // every status tick). The 0.3 s lead moves the highlight on as the narrator starts a paragraph.
  // While the app is not active the tick is stopped, then resumed with an immediate recompute.
  useEffect(() => {
    if (!source || phase !== 'ready' || !hasAnchors) { setCurrent(null); setLocated(false); return; }
    if (!appActive) return;
    const compute = () => {
      const seconds = extrapolatePosition(clockRef.current, Date.now()) + HIGHLIGHT_LEAD_SECONDS;
      const found = locate(record, source.wordToPara, fileId, seconds);
      // Only a paragraph change should re-render the list; the word can move within a paragraph.
      setCurrent((prev) => (prev && found && prev.para === found.para ? prev : found));
      setLocated(true);
    };
    compute();
    const id = setInterval(compute, HIGHLIGHT_TICK_MS);
    return () => clearInterval(id);
  }, [source, phase, hasAnchors, record, fileId, appActive]);

  // Going back to the current paragraph rebuilds the slice around it and remounts the list, the
  // same path a seek takes. The remount drops the row measurements taken against the browsed slice
  // (which following would otherwise position by, and which a prepend invalidates); browsing itself
  // only ever extends the slice, so the rows under the reader never move.
  const [listKey, setListKey] = useState(0);
  const refollow = useCallback(() => {
    if (followTimer.current) { clearTimeout(followTimer.current); followTimer.current = null; }
    const src = sourceRef.current;
    const cur = currentRef.current;
    if (src && cur && src.paragraphs.length) {
      rowY.current.clear();
      lastOffset.current = -1;
      prependFrom.current = null;
      growLock.current = false;
      pending.current = { index: cur.para, viewPosition: CURRENT_VIEW_POSITION };
      setWin(computeWindow(cur.para, src.paragraphs.length, EMPTY_WINDOW));
      setListKey((k) => k + 1);
      programmaticUntil.current = Date.now() + PROGRAMMATIC_MS;
    }
    setFollow(true);
  }, []);

  const armResume = useCallback(() => {
    if (followTimer.current) clearTimeout(followTimer.current);
    followTimer.current = setTimeout(refollow, FOLLOW_RESUME_MS);
  }, [refollow]);

  const pauseFollow = useCallback(() => {
    pending.current = null;
    lastOffset.current = -1; // the reader moved the list, so our last offset no longer holds
    setFollow(false);
    armResume();
  }, [armResume]);

  const resumeFollow = refollow;

  useEffect(() => () => { if (followTimer.current) clearTimeout(followTimer.current); }, []);

  // Bring `absIndex` to `viewPosition` down the viewport using its measured y. If it has not laid
  // out yet (a fresh window), remember the request and run it from the row's onLayout.
  const scrollToRow = useCallback((absIndex: number, viewPosition = CURRENT_VIEW_POSITION, animated = true) => {
    if (viewportH.current <= 0) { pending.current = { index: absIndex, viewPosition }; return; }
    const y = rowY.current.get(absIndex);
    if (y == null) { pending.current = { index: absIndex, viewPosition }; return; }
    pending.current = null;
    const offset = Math.max(0, y - viewportH.current * viewPosition);
    if (Math.abs(offset - lastOffset.current) < 1) return; // already there
    lastOffset.current = offset;
    programmaticUntil.current = Date.now() + PROGRAMMATIC_MS;
    listRef.current?.scrollToOffset({ offset, animated });
  }, []);

  const onRowLayout = useCallback((index: number, y: number) => {
    rowY.current.set(index, y);
    const p = pending.current;
    if (p && p.index === index) scrollToRow(p.index, p.viewPosition, false);
    else if (followRef.current && currentRef.current?.para === index) scrollToRow(index);
  }, [scrollToRow]);

  // The cell wrapper is the direct child of the scroll content, so its onLayout y is exactly the
  // content-relative offset VirtualizedList itself measures. The item's own onLayout is relative to
  // this wrapper (always ~0), so it is no use for positioning.
  const WindowCell = useCallback((props: any) => {
    const { item, onLayout, style, children } = props;
    return (
      <View style={style} onLayout={(e) => { onLayout?.(e); onRowLayout(item.index, e.nativeEvent.layout.y); }}>
        {children}
      </View>
    );
  }, [onRowLayout]);

  const onListLayout = useCallback((e: { nativeEvent: { layout: { height: number } } }) => {
    viewportH.current = e.nativeEvent.layout.height;
    if (followRef.current && currentRef.current) scrollToRow(currentRef.current.para);
    else if (pending.current) scrollToRow(pending.current.index, pending.current.viewPosition, false);
  }, [scrollToRow]);

  // Recentre + follow. While following, a window is chosen so the current paragraph sits ~30 rows
  // in; while the reader browses (follow off), the window is only grown by the viewability handler.
  useEffect(() => {
    if (phase !== 'ready' || !source || !current) return;
    const N = source.paragraphs.length;
    if (N <= 0) return;
    const empty = win.end <= win.start;
    const outside = empty || current.para < win.start || current.para >= win.end;
    if (follow && (outside || shouldRecentre(current.para, N, win))) {
      const next = computeWindow(current.para, N, win);
      if (next.start !== win.start || next.end !== win.end) {
        // A fresh window must not inherit the old offset: reset to the top and let the measured
        // current row position itself once it has laid out.
        rowY.current.clear();
        lastOffset.current = -1;
        pending.current = { index: current.para, viewPosition: CURRENT_VIEW_POSITION };
        setWin(next);
        programmaticUntil.current = Date.now() + PROGRAMMATIC_MS;
        listRef.current?.scrollToOffset({ offset: 0, animated: false });
        return;
      }
    }
    if (!follow) return;
    const id = setTimeout(() => scrollToRow(current.para), 0);
    return () => clearTimeout(id);
  }, [source, phase, follow, current?.para, win, scrollToRow]);

  // Only a scroll outside the programmatic grace period is the reader's. The offset is tracked
  // unconditionally for the web prepend correction (see onContentSizeChange).
  const handleScroll = useCallback((e: { nativeEvent: { contentOffset: { y: number } } }) => {
    scrollOffset.current = e.nativeEvent.contentOffset.y;
    if (Date.now() < programmaticUntil.current) return;
    pauseFollow();
  }, [pauseFollow]);

  // Drags and (on the web) wheel movement are unambiguous user intent.
  const userIntent = useCallback(() => {
    programmaticUntil.current = 0;
    pauseFollow();
  }, [pauseFollow]);

  const onContentSizeChange = useCallback((_width: number, height: number) => {
    const from = prependFrom.current;
    prependFrom.current = null;
    const grew = from != null && from.height > 0 && height > from.height;
    contentH.current = height;
    if (!grew) return;
    // react-native-web does not implement maintainVisibleContentPosition, so the rows prepended
    // above pushed the visible content down by the added height. Scroll by it, without animation
    // and inside the programmatic grace period, so it is not mistaken for the reader scrolling.
    // The target is counted from the offset at the moment of the prepend, not the live one: Chromium's
    // own scroll anchoring may already have moved the view, and adding the height again would double it.
    programmaticUntil.current = Date.now() + PROGRAMMATIC_MS;
    listRef.current?.scrollToOffset({ offset: from!.offset + (height - from!.height), animated: false });
  }, []);

  // Re-arm browsing growth once the slice it applied has been rendered.
  useEffect(() => { growLock.current = false; }, [win]);

  // While the reader scrolls by hand, *grow* the slice toward the edge they reach; it is never
  // re-centred here, so rows are never dropped out from under the scroll offset. Appending below
  // needs no correction (existing rows keep their y); prepending above leaves the existing rows'
  // measured y stale, so they are dropped and the list holds the view in place via
  // maintainVisibleContentPosition (Android) or onContentSizeChange (web).
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 10 }).current;
  const onViewableItemsChanged = useRef((info: { viewableItems: ViewToken<Row>[] }) => {
    if (Date.now() < programmaticUntil.current) return;
    if (followRef.current) return; // following recentres itself
    if (growLock.current) return;  // a grow is applied; wait until it has rendered
    const src = sourceRef.current;
    if (!src || !src.paragraphs.length) return;
    const items = info.viewableItems
      .filter((v) => v.item)
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    if (!items.length) return;
    const first = items[0].item.index;
    const last = items[items.length - 1].item.index;
    const w = winRef.current;
    const next = growWindow(first, last, src.paragraphs.length, w);
    if (next.start === w.start && next.end === w.end) return;
    growLock.current = true;
    if (next.start < w.start) {
      // Rows were prepended, so every existing row's content-relative y has shifted.
      rowY.current.clear();
      if (Platform.OS === 'web' && contentH.current > 0) prependFrom.current = { height: contentH.current, offset: scrollOffset.current };
    }
    setWin(next);
  }).current;

  // Android's ScrollView supports maintainVisibleContentPosition natively; react-native-web 0.21.3
  // does not implement it, so the web path corrects by hand above. Enabled only while browsing, so
  // it cannot fight the follow path's own repositioning after its remount.
  const MVCP = useMemo(() => ({ minIndexForVisible: 0 }), []);

  const onParagraph = useCallback((index: number) => {
    if (canSeek && !canSeek()) return; // the tap that reveals the chrome must not seek
    if (!source) return;
    const word = paragraphStartWord(source.wordToPara, index);
    const t = timeForWord(record, fileId, word);
    if (t == null) return;
    setCurrent({ para: index, word });
    onSeek(t);
  }, [source, record, fileId, onSeek, canSeek]);

  const noText = !!source && source.paragraphs.length === 0;
  // The chip shows once the reader has scrolled away from the paragraph being read.
  const showChip = !follow && current && phase === 'ready';
  const chip = (
    <Tap onPress={resumeFollow} hitSlop={8} accessibilityLabel="Back to current" style={{
      flexDirection: 'row', alignItems: 'center', gap: 6,
      paddingHorizontal: 12, height: 28, borderRadius: R.pill, backgroundColor: C.elevated,
      borderWidth: 1, borderColor: C.accent,
    }}>
      <Ionicons name="locate" size={13} color={C.accent} />
      <Text numberOfLines={1} style={{ color: C.accent, fontSize: 12, fontWeight: '700' }}>Back to current</Text>
    </Tap>
  );

  return (
    <View style={{ flex: 1 }}>
      {/* Header: a fixed 28px row with 8px below it. While the chrome is visible it holds the chip
          (once the reader has scrolled away) and the icon-only Manage button; while the chrome is
          hidden only the chip survives, on its own, so the reader can still snap back to the current
          paragraph. The chip's wrapper reports the touch (via onChipTouch) so the player can keep the
          chrome hidden for that tap; the chip itself is never faded. */}
      {chromeHidden ? (
        showChip ? (
          <View style={{ paddingBottom: 8 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', height: 28 }}>
              <View onTouchStart={onChipTouch}>{chip}</View>
            </View>
          </View>
        ) : null
      ) : (
        <View style={{ paddingBottom: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', height: 28 }}>
            <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center' }}>
              {showChip ? <View onTouchStart={onChipTouch}>{chip}</View> : null}
            </View>
            {onManage ? (
              <Tap onPress={onManage} scaleTo={0.94} hitSlop={8} accessibilityLabel="Manage read-along" style={{
                width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center',
                backgroundColor: C.elevated, borderWidth: 1, borderColor: C.line,
              }}>
                <Ionicons name="options-outline" size={13} color={C.sub} />
              </Tap>
            ) : null}
          </View>
        </View>
      )}

      {!chromeHidden && phase === 'ready' && source && !source.sha1Ok ? (
        <View style={{
          flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10, marginBottom: 8, borderRadius: R.md,
          backgroundColor: 'rgba(255,181,71,0.12)', borderWidth: 1, borderColor: 'rgba(255,181,71,0.35)',
        }}>
          <Ionicons name="warning-outline" size={16} color={C.accent} />
          <Text style={{ color: C.text, flex: 1, fontSize: 12 }}>
            This copy of the EPUB doesn’t match the read-along; rebuild it on the desktop.
          </Text>
        </View>
      ) : null}

      <View style={{ flex: 1 }}>
        {!hasAnchors ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, paddingHorizontal: 24 }}>
            <Ionicons name="book-outline" size={30} color={C.faint} />
            <Text style={[T.body, { textAlign: 'center' }]}>No read-along for this file</Text>
          </View>
        ) : phase === 'loading' || phase === 'downloading' ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 }}>
            <ActivityIndicator color={C.accent} />
            <Text style={T.body}>{phase === 'downloading' ? 'Downloading the EPUB…' : 'Reading the EPUB…'}</Text>
          </View>
        ) : phase === 'error' ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14, paddingHorizontal: 20 }}>
            <Ionicons name="alert-circle-outline" size={34} color={C.danger} />
            <Text style={[T.body, { textAlign: 'center' }]}>{error}</Text>
            <Button kind="ghost" icon="refresh" label="Retry" onPress={load} />
          </View>
        ) : noText ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, paddingHorizontal: 24 }}>
            <Ionicons name="document-outline" size={30} color={C.faint} />
            <Text style={[T.body, { textAlign: 'center' }]}>This EPUB has no readable paragraphs.</Text>
          </View>
        ) : located && !current ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, paddingHorizontal: 24 }}>
            <Ionicons name="help-circle-outline" size={30} color={C.faint} />
            <Text style={[T.body, { textAlign: 'center' }]}>
              No paragraph matches this playback position. The read-along may not cover this part of the file.
            </Text>
          </View>
        ) : (
          <FlatList
            key={listKey}
            ref={listRef}
            data={rows}
            keyExtractor={(item) => String(item.index)}
            extraData={current?.para} // rows only re-render for the highlight when this changes
            CellRendererComponent={WindowCell}
            renderItem={({ item }) => (
              <Paragraph text={item.text} index={item.index} current={item.index === current?.para} onPress={onParagraph} />
            )}
            onLayout={onListLayout}
            onContentSizeChange={onContentSizeChange}
            onScroll={handleScroll}
            onScrollBeginDrag={userIntent}
            {...(Platform.OS === 'web' ? ({ onWheel: userIntent } as any) : null)}
            scrollEventThrottle={100}
            onViewableItemsChanged={onViewableItemsChanged}
            viewabilityConfig={viewabilityConfig}
            // Keep the visible row fixed when the reader's browsing prepends rows above it. Only
            // while browsing: the follow path remounts and repositions the list itself.
            maintainVisibleContentPosition={follow ? undefined : MVCP}
            // Android's default is true; the slice is replaced under a live scroll offset, where
            // detaching clipped cells can leave the whole panel blank.
            removeClippedSubviews={false}
            showsVerticalScrollIndicator={false}
            initialNumToRender={INITIAL_RENDER}
            maxToRenderPerBatch={INITIAL_RENDER}
            windowSize={15}
            contentContainerStyle={{ paddingVertical: 6, paddingBottom: 40 }}
          />
        )}
      </View>
    </View>
  );
}

const Paragraph = React.memo(function Paragraph({ text, index, current, onPress }: {
  text: string; index: number; current: boolean; onPress: (index: number) => void;
}) {
  return (
    <Tap onPress={() => onPress(index)} scaleTo={1} style={{ paddingVertical: 7, paddingHorizontal: 2 }}>
      <Text
        style={{
          fontFamily: SERIF,
          fontSize: 18,
          lineHeight: 30,
          color: current ? C.accent : 'rgba(245,244,247,0.62)',
        }}
      >
        {text}
      </Text>
    </Tap>
  );
});
