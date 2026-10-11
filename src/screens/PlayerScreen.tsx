import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Modal, FlatList, ScrollView, useWindowDimensions, ActivityIndicator, TextInput, Image, Animated, Platform, AppState } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { C, R, T, paletteFor, fmtTime, fmtApprox, prettyName } from '../theme';
import { Tap, Cover, Sheet, Button, IconButton, toast, Pop, FadeIn, SkipIcon } from '../components/ui';
import { Scrubber } from '../components/Scrubber';
import { usePlayer } from '../player/PlayerContext';
import { remainingBookSeconds } from '../book-math';
import { chapterTitle } from '../torbox';
import { formatBytes } from '../scrapers/template';
import { getHcToken, getLink, linkBook, unlink, searchBooks, subscribeHcSyncError, HcBook, HcLink, HcSyncError } from '../hardcover';
import { CoverPicker } from '../components/CoverPicker';
import { ReadalongSheet, useReadalongJob } from '../components/ReadalongSheet';
import { ReadalongView } from '../components/ReadalongView';
import { readalongTime, readalongSeekTarget } from '../player/seekbase';
import { seekAllowed, CHROME_IDLE_MS, CHROME_HIDE_MS, CHROME_SHOW_MS } from '../player/idle-chrome';
import type { SeekModel } from '../readalong/mp3seek';
import { loadReadalong } from '../storage';
import type { BookMeta } from '../storage';
import type { ReadalongRecord } from '../readalong/anchors';
import { readalongBridge } from '../readalong/desktop';
import { serverConfigured } from '../readalong/server';
import { checkPendingForBook } from '../readalong/background';
import { jobActive } from '../readalong/job';
import { subscribeSyncStatus } from '../sync';
import { useLayout } from '../layout';
import { useEscape } from '../escape';
import { playerPanes } from '../player/panes';
import type { PlayerBarSheet } from '../components/Chrome';

const RATES = [0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const SLEEP = [5, 15, 30, 45, 60, 90];

// One toast a session for the first Hardcover sync failure; later ones only light up the pill.
let hcFailureToasted = false;

// Immersive reading. While `active`, no input for CHROME_IDLE_MS fades the player's chrome out and
// then drops it from the layout; any input fades it back and restarts the timer. `poke` is called
// from every input; `revealedAt` is a ref so the tap that reveals the chrome can be told apart from
// one that should seek within the same touch.
function useIdleChrome(active: boolean) {
  const [hidden, setHidden] = useState(false);       // the fade-out has begun
  const [collapsed, setCollapsed] = useState(false); // the fade-out finished: out of layout
  const opacity = useRef(new Animated.Value(1)).current;
  const activeRef = useRef(active); activeRef.current = active;
  const hiddenRef = useRef(false); hiddenRef.current = hidden;
  const collapsedRef = useRef(false); collapsedRef.current = collapsed;
  const revealedAt = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Bumped on every reveal; a hide animation only collapses the layout if its generation is current,
  // so a reveal that lands as the fade finishes cannot be undone by the stale completion.
  const generation = useRef(0);

  const stopTimer = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
  }, []);

  const show = useCallback(() => {
    stopTimer();
    if (!hiddenRef.current && !collapsedRef.current) return; // already shown
    generation.current++;
    setCollapsed(false);
    setHidden(false);
    revealedAt.current = Date.now();
    opacity.setValue(0);
    Animated.timing(opacity, { toValue: 1, duration: CHROME_SHOW_MS, useNativeDriver: true }).start();
  }, [opacity, stopTimer]);

  const schedule = useCallback(() => {
    stopTimer();
    const g = generation.current;
    timer.current = setTimeout(() => {
      timer.current = null;
      setHidden(true);
      Animated.timing(opacity, { toValue: 0, duration: CHROME_HIDE_MS, useNativeDriver: true })
        .start(({ finished }) => { if (finished && g === generation.current) setCollapsed(true); });
    }, CHROME_IDLE_MS);
  }, [opacity, stopTimer]);

  const poke = useCallback(() => {
    if (!activeRef.current) return;
    show();
    schedule();
  }, [show, schedule]);

  useEffect(() => {
    if (!active) {
      // Leaving the eligible state shows everything again at once and cancels the timer.
      stopTimer();
      generation.current++;
      if (hiddenRef.current || collapsedRef.current) {
        setCollapsed(false);
        setHidden(false);
        revealedAt.current = Date.now();
        opacity.setValue(1);
      }
      return;
    }
    schedule();
    return stopTimer;
  }, [active, schedule, stopTimer, opacity]);

  return { hidden, collapsed, opacity, poke, revealedAt };
}

export function PlayerScreen({ visible, openSheet, onSheetOpened, onClose, onMeta }: {
  visible: boolean; openSheet?: PlayerBarSheet; onSheetOpened?: () => void; onClose: () => void; onMeta: (all: Record<string, BookMeta>) => void;
}) {
  const p = usePlayer();
  const { height } = useWindowDimensions();
  // Inside an Android Modal neither the app-level insets nor SafeAreaView reliably report the
  // navigation bar, and a three-button bar (48dp) then covers the bottom row. Reserve at least that
  // much on Android whatever the insets say; on gesture phones it is just a little extra space.
  const appInsets = useSafeAreaInsets();
  const bottomPad = 16 + Math.max(appInsets.bottom, Platform.OS === 'android' ? 48 : 0);
  const { dialogWidth: width, wide, width: windowWidth } = useLayout(); // the player is a centred column on desktop
  const [sheet, setSheet] = useState<null | 'chapters' | 'speed' | 'sleep' | 'hardcover' | 'cover' | 'readalong'>(null);
  const [chaptersSignal, setChaptersSignal] = useState(0); // bumped to scroll the desktop pane to the current chapter
  const [hcLink, setHcLink] = useState<HcLink | null | undefined>(undefined);
  const [hcError, setHcError] = useState<HcSyncError | null>(null);
  const [hcOn, setHcOn] = useState(false);
  const [readalongRecord, setReadalongRecord] = useState<ReadalongRecord | null>(null);
  // Every finished sync re-reads the record. Keep the object we already have when nothing in it
  // changed: the text view reloads the whole EPUB (seconds of blank screen) for a new record.
  const keepRecord = (r: ReadalongRecord | null) =>
    setReadalongRecord((prev) => (prev && r && JSON.stringify(prev) === JSON.stringify(r) ? prev : r));
  const [artBox, setArtBox] = useState(0); // height left for the cover, measured below
  const [showText, setShowText] = useState(false);
  const [, tick] = useState(0);
  const [appActive, setAppActive] = useState(AppState.currentState !== 'background');
  const readalong = readalongBridge();
  const readalongJob = useReadalongJob();
  const [serverReady, setServerReady] = useState(false);

  // Escape closes this screen, but only when no Sheet inside it is on top of the escape stack.
  useEscape(onClose, visible);
  // A PlayerBar control asks for the player to open with one of its sheets already showing. On
  // desktop there is no chapters sheet: the chapters button focuses the right pane instead.
  useEffect(() => {
    if (!visible || !openSheet) return;
    if (wide && openSheet === 'chapters') {
      setShowText(false);
      setChaptersSignal((n) => n + 1);
    } else {
      setSheet(openSheet);
    }
    onSheetOpened?.();
  }, [visible, openSheet, wide]);

  // The artwork leans in while the book is playing and settles back when paused.
  const artScale = useRef(new Animated.Value(p.playing ? 1 : 0.86)).current;
  useEffect(() => {
    Animated.spring(artScale, { toValue: p.playing ? 1 : 0.86, useNativeDriver: true, damping: 14, stiffness: 140, mass: 0.9 }).start();
  }, [p.playing]);

  useEffect(() => {
    if (!visible || !p.book) return;
    getHcToken().then((t) => setHcOn(!!t));
    getLink(p.book.id).then((l) => setHcLink(l ?? null));
  }, [visible, p.book?.id]);

  // Hardcover sync failures: the Track pill turns red and the link sheet explains; the first one this
  // session also gets a toast. Cleared when a later update succeeds.
  useEffect(() => subscribeHcSyncError((e) => {
    setHcError(e);
    if (e && !hcFailureToasted) {
      hcFailureToasted = true;
      toast('Hardcover didn’t accept the progress update; will keep trying.', 'err');
    }
  }), []);

  useEffect(() => { // the saved record drives the Read pill / text view (a phone has no desktop bridge)
    if (!p.book) return;
    setReadalongRecord(null);
    setShowText(false);
  }, [p.book?.hash]);

  // Look the record up again whenever the player opens and after each sync, because a read-along
  // made on the desktop arrives through sync while this book may already be loaded.
  useEffect(() => {
    if (!p.book || !visible) return;
    const hash = p.book.hash;
    let alive = true;
    const reload = () => { loadReadalong(hash).then((r) => { if (alive) keepRecord(r); }, () => {}); };
    let lastSync = -1;
    const unsubscribe = subscribeSyncStatus((s) => {
      if (s.busy || s.lastSyncAt === lastSync) return;
      lastSync = s.lastSyncAt;
      reload();
    });
    return () => { alive = false; unsubscribe(); };
  }, [p.book?.hash, visible]);

  useEffect(() => { // a configured server means the Read pill can start a build
    if (!visible) return;
    let alive = true;
    serverConfigured().then((ok) => { if (alive) setServerReady(ok); }, () => { if (alive) setServerReady(false); });
    return () => { alive = false; };
  }, [visible]);

  useEffect(() => { // picking up a book checks for a server build that finished while away
    if (!p.book || !visible) return;
    const hash = p.book.hash;
    let alive = true;
    checkPendingForBook(hash)
      .then(() => loadReadalong(hash).then((r) => { if (alive) keepRecord(r); }, () => {}))
      .catch(() => {});
    return () => { alive = false; };
  }, [p.book?.hash, visible]);

  useEffect(() => { // a finished build (this book or another) refreshes the record for the pill
    if (!p.book || readalongJob.status !== 'done') return;
    loadReadalong(p.book.hash).then((r) => keepRecord(r), () => {});
  }, [readalongJob.status, p.book?.hash]);

  useEffect(() => { // removing the record (via Manage) puts the artwork back
    if (!readalongRecord) setShowText(false);
  }, [readalongRecord]);

  useEffect(() => { // the sleep countdown only needs ticking while the app can draw it
    if (p.sleep?.kind !== 'minutes' || !appActive) return;
    tick((x) => x + 1); // recompute at once when the app comes back
    const id = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(id);
  }, [p.sleep, appActive]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => setAppActive(next !== 'background'));
    return () => sub.remove();
  }, []);

  // With a Xing seek map, the read-along works in true audio time: the highlight follows the
  // converted clock and a tap seeks to the player-time that lands on those words. Android seeks
  // with media3, the desktop/web build with Chromium's ffmpeg demuxer; every other consumer of
  // p.position keeps the reported time unchanged.
  const raFileId = p.chapters[p.index]?.id ?? -1;
  const raSeek = readalongRecord?.files.find((f) => f.id === raFileId)?.seek ?? null;
  const raModel: SeekModel | null = Platform.OS === 'android' ? 'media3' : Platform.OS === 'web' ? 'ffmpeg' : null;

  // The desktop split: what the right pane holds, or no second pane for a one-file book with no
  // read-along. Pure logic, in src/player/panes.ts so the test runner covers it.
  const panes = playerPanes({ wide, chapterCount: p.chapters.length, hasReadalong: !!readalongRecord, showText });
  // The right pane's content and its heading. The title is the same text the chapters Sheet shows.
  const showingText = panes.right === 'text' && !!readalongRecord;
  // In the single column, reading puts the text above a compacted controls block. Never true in the
  // desktop two-pane split (that pane renders `controls(true)`, always full size).
  const reading = showText && !!readalongRecord;
  // Immersive reading is eligible only in the full player, with the text showing and no sheet open.
  const chromeActive = visible && (reading || showingText) && sheet === null;
  const { hidden: chromeHidden, collapsed: chromeCollapsed, opacity: chromeOpacity, poke: chromePoke, revealedAt } = useIdleChrome(chromeActive);

  // The touch that reveals the chrome must not also seek (paragraphs are tap-to-seek). `touchHidden`
  // records whether the chrome was hidden when this touch began, before `poke` reveals it, and
  // `revealedAt` covers a tap just after a reveal — both refs, so they hold within one touch.
  const chromeHiddenRef = useRef(false); chromeHiddenRef.current = chromeHidden;
  const touchHidden = useRef(false);
  const canSeek = useCallback(() => seekAllowed(touchHidden.current, revealedAt.current, Date.now()), [revealedAt]);
  // The "Back to current" chip keeps working while the chrome is hidden, but its tap must not bring
  // the chrome back. The chip's wrapper sets this flag on touch start (which bubbles child-first);
  // the root handler below then skips the poke. Only set while hidden, so a tap on a visible chip is
  // an ordinary input.
  const chipTouched = useRef(false);
  const onChipTouch = useCallback(() => {
    if (chromeHiddenRef.current) chipTouched.current = true;
  }, []);
  const onRootTouchStart = useCallback(() => {
    if (chipTouched.current) { chipTouched.current = false; return; } // the chip's tap: stay hidden
    touchHidden.current = chromeHiddenRef.current;
    chromePoke();
  }, [chromePoke]);

  // On the web, moving the mouse, wheeling and pressing a key are input too. Added only while the
  // player is visible; the keydown listener does not consume the event, so the app's space/arrow
  // shortcuts and Escape keep working.
  useEffect(() => {
    if (Platform.OS !== 'web' || !visible) return;
    const w = globalThis as any;
    const onAny = () => chromePoke();
    w.addEventListener?.('mousemove', onAny);
    w.addEventListener?.('wheel', onAny, { passive: true });
    w.addEventListener?.('keydown', onAny);
    return () => {
      w.removeEventListener?.('mousemove', onAny);
      w.removeEventListener?.('wheel', onAny);
      w.removeEventListener?.('keydown', onAny);
    };
  }, [visible, chromePoke]);

  if (!p.book) return null;
  const book = p.book;
  const [c1] = paletteFor(book.name);
  // The cover takes whatever height is left once the title, scrubber, controls and buttons are laid
  // out, so the whole player fits on short phone screens.
  const art = Math.max(120, Math.min(width - 64, artBox ? artBox - 16 : height * 0.4, 380));
  const sleepLabel = !p.sleep ? 'Sleep' : p.sleep.kind === 'chapter' ? 'End ch.' : fmtTime((p.sleep.endsAt - Date.now()) / 1000);
  // Whole-book time left, estimated from the current file's duration and the file-size ratio.
  const bookLeft = remainingBookSeconds(p.chapters.map((f) => f.size), p.index, p.position, p.duration, p.chapters.length);

  const twoPane = panes.twoPane;
  // The left pane stays a comfortable fixed width; the cover is scaled to fit it rather than filling it.
  const paneWidth = Math.min(430, Math.max(370, Math.round(windowWidth * 0.34)));
  const paneArt = Math.max(140, Math.min(paneWidth - 48, height * 0.42, 340));
  const paneTitle = showingText ? 'Read along' : `${p.chapters.length} chapter${p.chapters.length === 1 ? '' : 's'}`;

  const readalongView = () => (
    <ReadalongView
      audioHash={book.hash}
      record={readalongRecord!}
      fileId={p.chapters[p.index]?.id ?? -1}
      clock={{
        position: readalongTime(raSeek, raModel, p.seekBase, p.position),
        at: p.positionAt,
        rate: p.rate,
        playing: p.playing,
        loading: p.loading,
        recovering: p.recovering,
        seekPending: p.seekPending,
      }}
      onSeek={(seconds) => p.seek(readalongSeekTarget(raSeek, raModel, seconds))}
      onManage={(readalong || serverReady) ? () => setSheet('readalong') : undefined}
      chromeHidden={chromeCollapsed}
      canSeek={canSeek}
      onChipTouch={onChipTouch}
    />
  );

  // The top row is the same in both layouts; on desktop the chapters button becomes a spacer, because
  // the chapter list lives in the right pane, not a sheet.
  const headerRow = (desktop: boolean) => (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
      <IconButton label="Close player" name="chevron-down" onPress={onClose} size={26} />
      <View style={{ alignItems: 'center', flex: 1 }}>
        <Text style={[T.label, { color: 'rgba(255,255,255,0.65)' }]}>Now playing</Text>
        <Text numberOfLines={1} style={{ color: C.text, fontWeight: '600', fontSize: 13, marginTop: 2 }}>
          Chapter {p.index + 1} of {p.chapters.length}
        </Text>
      </View>
      {desktop ? <View style={{ width: 42 }} /> : <IconButton label="Chapters" name="list" onPress={() => setSheet('chapters')} size={22} />}
    </View>
  );

  const hcFailed = !!hcLink && !!hcError;
  const titleRow = (
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 12, marginBottom: 18 }}>
      <View style={{ flex: 1 }}>
        <Text numberOfLines={2} style={[T.h2, { fontSize: 24, letterSpacing: -0.5 }]}>{p.displayTitle}</Text>
        <Text numberOfLines={1} style={[T.body, { marginTop: 4, fontSize: 15 }]}>
          {p.meta.author ?? hcLink?.authors?.[0] ?? p.chapterName}
        </Text>
      </View>
      {hcOn && (
        <Tap onPress={() => setSheet('hardcover')} scaleTo={0.9} style={{
          flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, height: 34, borderRadius: R.pill,
          backgroundColor: hcFailed ? 'rgba(255,107,107,0.16)' : hcLink ? 'rgba(124,92,255,0.22)' : 'rgba(255,255,255,0.08)',
          borderWidth: 1, borderColor: hcFailed ? C.danger : hcLink ? '#7C5CFF' : C.line,
        }}>
          <Ionicons name={hcLink ? 'bookmarks' : 'bookmarks-outline'} size={14} color={hcFailed ? C.danger : hcLink ? '#B9A8FF' : C.sub} />
          <Text style={{ color: hcFailed ? C.danger : hcLink ? '#D8CEFF' : C.sub, fontSize: 12, fontWeight: '700' }}>{hcLink ? 'Tracking' : 'Track'}</Text>
        </Tap>
      )}
    </View>
  );

  // Error banner, scrubber and transport, then the pills: the bottom of the column on a phone, the
  // bottom of the left pane on desktop. There is no Chapters pill on desktop — the pane already shows
  // the list — and a one-file read-along pins its text, so its Read toggle is dropped too. While the
  // phone shows the text, `compact` shrinks the transport and drops the "left in book" line to give
  // the reading more room; everything else is identical.
  const controls = (desktop: boolean, compact = false) => (
    <>
      {p.error ? (
        <Tap onPress={() => p.goChapter(p.index)} style={{ flexDirection: 'row', gap: 8, alignItems: 'center', padding: 10, borderRadius: R.md, backgroundColor: 'rgba(255,107,107,0.12)', marginBottom: 10 }}>
          <Ionicons name="refresh" size={16} color={C.danger} />
          <Text style={{ color: C.text, flex: 1, fontSize: 13 }}>{p.error} · tap to retry</Text>
        </Tap>
      ) : null}

      <Scrubber position={p.position} duration={p.duration} onSeek={p.seek} />
      <Text numberOfLines={1} style={[T.small, { textAlign: 'center', marginTop: 6 }]}>{p.recovering ? 'Reconnecting…' : p.chapterName}{!p.recovering && p.local && Platform.OS !== 'web' ? ' · Downloaded' : ''}</Text>
      {bookLeft != null && !compact ? (
        <Text numberOfLines={1} style={[T.small, { textAlign: 'center', marginTop: 2 }]}>About {fmtApprox(bookLeft)} left in book</Text>
      ) : null}

      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: compact ? 10 : 18, marginBottom: compact ? 14 : 26 }}>
        <IconButton label="Previous chapter" name="play-skip-back" size={compact ? 22 : 26} onPress={() => (p.position > 5 ? p.seek(0) : p.goChapter(p.index - 1))} />
        <Tap onPress={() => p.skip(-p.skipBack)} haptic scaleTo={0.8} hitSlop={8} accessibilityLabel={`Skip back ${p.skipBack} seconds`} style={{ padding: 8 }}>
          <SkipIcon dir="back" seconds={p.skipBack} size={compact ? 28 : 34} />
        </Tap>
        <Tap onPress={p.toggle} haptic scaleTo={0.9} accessibilityLabel={p.playing ? 'Pause' : 'Play'} style={{ width: compact ? 60 : 84, height: compact ? 60 : 84, borderRadius: compact ? 30 : 42, overflow: 'hidden' }}>
          <LinearGradient colors={[C.accent, C.accentDeep]} style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            {p.loading || p.recovering ? <ActivityIndicator color={C.accentInk} size={compact ? 'small' : 'large'} /> : (
              <Pop on={p.playing} from={0.55}>
                <Ionicons name={p.playing ? 'pause' : 'play'} size={compact ? 28 : 40} color={C.accentInk} style={{ marginLeft: p.playing ? 0 : 4 }} />
              </Pop>
            )}
          </LinearGradient>
        </Tap>
        <Tap onPress={() => p.skip(p.skipForward)} haptic scaleTo={0.8} hitSlop={8} accessibilityLabel={`Skip forward ${p.skipForward} seconds`} style={{ padding: 8 }}>
          <SkipIcon dir="forward" seconds={p.skipForward} size={compact ? 28 : 34} />
        </Tap>
        <IconButton label="Next chapter" name="play-skip-forward" size={compact ? 22 : 26} disabled={p.index >= p.chapters.length - 1} onPress={() => p.goChapter(p.index + 1)} />
      </View>

      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
        <Pill icon="speedometer-outline" label={`${p.rate}×`} accessibilityLabel={`Playback speed, ${p.rate}×`} active={p.rate !== 1} onPress={() => setSheet('speed')} />
        <Pill icon="moon-outline" label={sleepLabel} accessibilityLabel={`Sleep timer, ${sleepLabel}`} active={!!p.sleep} onPress={() => setSheet('sleep')} />
        {!desktop && <Pill icon="albums-outline" label="Chapters" accessibilityLabel="Chapters" onPress={() => setSheet('chapters')} />}
        {(readalong || readalongRecord || serverReady) && !(desktop && panes.textFixed) && (
          <Pill icon="book-outline" label="Read" accessibilityLabel="Read along" active={showText || jobActive(readalongJob)}
            onPress={() => {
              if (readalongRecord) setShowText((v) => !v);
              else setSheet('readalong');
            }} />
        )}
      </View>
    </>
  );

  // The phone layout, and the desktop fallback for a one-file book with no read-along. Unchanged
  // except while reading: the text sits closer to the compacted controls below it. While reading the
  // header and the controls block are the phone's chrome — they fade out and then leave the layout
  // so the text fills the screen. When Read is off nothing changes.
  const singleBody = (
    <>
      <Animated.View style={{ opacity: chromeOpacity, display: chromeCollapsed ? 'none' : 'flex' }}>
        {headerRow(wide)}
      </Animated.View>
      {reading ? (
        <View style={{ flex: 1, marginBottom: 8 }}>{readalongView()}</View>
      ) : (
        <>
          <View style={{ flex: 1, minHeight: 0, alignItems: 'center', justifyContent: 'center' }} onLayout={(e) => setArtBox(e.nativeEvent.layout.height)}>
            <Animated.View style={{ transform: [{ scale: artScale }] }}>
              <Tap onPress={() => setSheet('cover')} scaleTo={0.98} accessibilityLabel="Change cover" style={{ shadowColor: '#000', shadowOpacity: 0.6, shadowRadius: 30, shadowOffset: { width: 0, height: 16 }, elevation: 24, borderRadius: R.lg }}>
                <Cover title={book.name} uri={p.meta.cover ?? hcLink?.image} size={art} radius={R.lg} />
              </Tap>
            </Animated.View>
          </View>
          {titleRow}
        </>
      )}
      <Animated.View style={{ opacity: chromeOpacity, display: chromeCollapsed ? 'none' : 'flex' }}>
        {controls(wide, reading)}
      </Animated.View>
    </>
  );

  // Two panes: the controls on the left, the chapter list or the read-along text on the right. Each
  // pane scrolls on its own; the divider uses the theme's border colour. While the text is showing,
  // the left pane (and its divider) and the right pane's heading are the chrome: they fade out and
  // collapse, leaving the text column centred at its existing max width.
  const splitBody = (
    <View style={{ flex: 1, flexDirection: 'row' }}>
      <Animated.View style={{ width: paneWidth, borderRightWidth: 1, borderRightColor: C.line, opacity: chromeOpacity, display: chromeCollapsed ? 'none' : 'flex' }}>
        <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 8 }}>
          {headerRow(true)}
          <View style={{ alignItems: 'center', marginTop: 8, marginBottom: 18 }}>
            <Animated.View style={{ transform: [{ scale: artScale }] }}>
              <Tap onPress={() => setSheet('cover')} scaleTo={0.98} accessibilityLabel="Change cover" style={{ shadowColor: '#000', shadowOpacity: 0.6, shadowRadius: 30, shadowOffset: { width: 0, height: 16 }, elevation: 24, borderRadius: R.lg }}>
                <Cover title={book.name} uri={p.meta.cover ?? hcLink?.image} size={paneArt} radius={R.lg} />
              </Tap>
            </Animated.View>
          </View>
          {titleRow}
          {controls(true)}
        </ScrollView>
      </Animated.View>

      <View style={{ flex: 1 }}>
        <View style={{ flex: 1, width: '100%', maxWidth: 780, alignSelf: 'center', paddingHorizontal: 24 }}>
          {/* The heading row is the height of the left pane's header (IconButton box: 26 + 20) so the
              two panes' titles sit on the same line. Its 20px inset lines it up with the list rows. */}
          <Animated.View style={{ opacity: chromeOpacity, display: chromeCollapsed ? 'none' : 'flex' }}>
            <View style={{ height: 46, justifyContent: 'center', paddingHorizontal: 20 }}>
              <Text numberOfLines={1} style={T.h2}>{paneTitle}</Text>
            </View>
          </Animated.View>
          <View style={{ flex: 1, marginTop: 10, paddingHorizontal: showingText ? 20 : 0 }}>
            {showingText ? readalongView() : (
              <ChapterList onPick={(i) => p.goChapter(i)} scrollToken={chaptersSignal} style={{ flex: 1 }} />
            )}
          </View>
        </View>
      </View>
    </View>
  );

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      {/* Any touch anywhere in the player is input for the immersive reading timer. This bubbling
          onTouchStart never takes the responder, so scrolling the text and pressing buttons work as
          usual; the "Back to current" chip, whose wrapper handles the touch first, is the one touch
          that keeps the chrome hidden. */}
      <View
        style={{ flex: 1, backgroundColor: C.bg }}
        onTouchStart={onRootTouchStart}
      >
        <LinearGradient colors={[c1 + 'AA', C.bg]} locations={[0, 0.7]} style={{ position: 'absolute', left: 0, right: 0, top: 0, height: height * 0.75 }} />
        {/* SafeAreaView measures the insets itself: inside an Android Modal the app-level insets can be
            wrong, which pushed the bottom row behind the navigation bar. */}
        <SafeAreaView edges={['top']} style={twoPane
          ? { flex: 1, paddingTop: 6, paddingBottom: bottomPad, width: '100%' }
          : { flex: 1, paddingTop: 6, paddingBottom: bottomPad, paddingHorizontal: 24, width: '100%', maxWidth: 600, alignSelf: 'center' }}>
          {twoPane ? splitBody : singleBody}
        </SafeAreaView>

        <Sheet visible={sheet === 'chapters'} onClose={() => setSheet(null)} title={`${p.chapters.length} chapter${p.chapters.length === 1 ? '' : 's'}`}>
          <ChapterList onPick={(i) => { p.goChapter(i); setSheet(null); }} />
        </Sheet>

        <Sheet visible={sheet === 'speed'} onClose={() => setSheet(null)} title="Playback speed">
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, paddingHorizontal: 20 }}>
            {RATES.map((r) => (
              <Tap key={r} onPress={() => { p.setRate(r); setSheet(null); }} style={{
                width: (width - 40 - 40) / 5, height: 56, borderRadius: R.md, alignItems: 'center', justifyContent: 'center',
                backgroundColor: p.rate === r ? C.accent : C.elevated,
              }}>
                <Text style={{ color: p.rate === r ? C.accentInk : C.text, fontWeight: '800', fontSize: 16 }}>{r}×</Text>
              </Tap>
            ))}
          </View>
        </Sheet>

        <Sheet visible={sheet === 'sleep'} onClose={() => setSheet(null)} title="Sleep timer">
          <View style={{ paddingHorizontal: 20, gap: 10 }}>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
              {SLEEP.map((m) => (
                <Tap key={m} onPress={() => { p.setSleep(m); setSheet(null); toast(`Pausing in ${m} minutes`); }}
                  style={{ width: (width - 40 - 20) / 3, height: 56, borderRadius: R.md, alignItems: 'center', justifyContent: 'center', backgroundColor: C.elevated }}>
                  <Text style={{ color: C.text, fontWeight: '800', fontSize: 16 }}>{m} min</Text>
                </Tap>
              ))}
            </View>
            <Button kind="ghost" icon="bookmark-outline" label="End of this chapter" onPress={() => { p.setSleep('chapter'); setSheet(null); }} />
            {p.sleep && <Button kind="danger" icon="close" label="Turn off timer" onPress={() => { p.setSleep('off'); setSheet(null); }} />}
          </View>
        </Sheet>

        <HardcoverLinkSheet visible={sheet === 'hardcover'} onClose={() => setSheet(null)} link={hcLink ?? null}
          error={hcError} torrentId={p.book.id} defaultQuery={p.meta.title ?? prettyName(p.book.name)} onLink={setHcLink} />

        <ReadalongSheet visible={sheet === 'readalong'} onClose={() => {
          setSheet(null);
          if (p.book) loadReadalong(p.book.hash).then((r) => keepRecord(r), () => {});
        }}
          book={p.book} meta={p.meta} chapters={p.chapters} index={p.index} />

        {sheet === 'cover' && <CoverPicker visible onClose={() => setSheet(null)} book={p.book} meta={p.meta} onSaved={onMeta} />}
      </View>
    </Modal>
  );
}

function Pill({ icon, label, onPress, active, accessibilityLabel }: { icon: any; label: string; onPress: () => void; active?: boolean; accessibilityLabel?: string }) {
  return (
    <Tap onPress={onPress} accessibilityLabel={accessibilityLabel ?? label} accessibilityState={{ selected: !!active }} style={{
      flex: 1, height: 44, borderRadius: R.pill, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4,
      backgroundColor: active ? 'rgba(255,181,71,0.15)' : 'rgba(255,255,255,0.07)', borderWidth: 1, borderColor: active ? C.accent : 'transparent',
    }}>
      <Ionicons name={icon} size={15} color={active ? C.accent : C.sub} />
      <Text numberOfLines={1} style={{ color: active ? C.accent : C.text, fontWeight: '700', fontSize: 12, fontVariant: ['tabular-nums'] }}>{label}</Text>
    </Tap>
  );
}

function ChapterList({ onPick, scrollToken = 0, style }: { onPick: (i: number) => void; scrollToken?: number; style?: any }) {
  const p = usePlayer();
  const ref = useRef<FlatList>(null);
  // The desktop bar's chapters button bumps `scrollToken` to bring the current chapter back into view
  // (the pane may already be open, where `initialScrollIndex` has long since been applied).
  useEffect(() => {
    if (!scrollToken) return;
    ref.current?.scrollToIndex({ index: Math.max(0, p.index - 2), viewPosition: 0, animated: true });
  }, [scrollToken]);
  return (
    <FlatList
      ref={ref}
      style={style}
      data={p.chapters}
      keyExtractor={(c) => String(c.id)}
      initialScrollIndex={Math.max(0, p.index - 2)}
      getItemLayout={(_d, i) => ({ length: 60, offset: 60 * i, index: i })}
      onScrollToIndexFailed={() => {}}
      renderItem={({ item, index }) => {
        const cur = index === p.index;
        const done = index < p.index;
        return (
          <Tap onPress={() => onPick(index)} scaleTo={0.99} accessibilityLabel={`${chapterTitle(item)}${cur ? ', current' : done ? ', finished' : ''}`} accessibilityState={{ selected: cur }} style={{ height: 60, flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 20, backgroundColor: cur ? 'rgba(255,181,71,0.08)' : 'transparent' }}>
            <View style={{ width: 28, alignItems: 'center' }}>
              {cur ? <Ionicons name={p.playing ? 'volume-high' : 'pause'} size={18} color={C.accent} /> :
                done ? <Ionicons name="checkmark-circle" size={18} color={C.faint} /> :
                  <Text style={{ color: C.faint, fontWeight: '700', fontVariant: ['tabular-nums'] }}>{index + 1}</Text>}
            </View>
            <View style={{ flex: 1 }}>
              <Text numberOfLines={1} style={{ color: cur ? C.accent : done ? C.sub : C.text, fontWeight: cur ? '700' : '500', fontSize: 15 }}>{chapterTitle(item)}</Text>
              <Text style={T.small}>{cur && p.duration ? `${fmtTime(p.position)} / ${fmtTime(p.duration)}` : formatBytes(item.size)}</Text>
            </View>
          </Tap>
        );
      }}
    />
  );
}

function HardcoverLinkSheet({ visible, onClose, link, error, torrentId, defaultQuery, onLink }: {
  visible: boolean; onClose: () => void; link: HcLink | null; error?: HcSyncError | null; torrentId: number; defaultQuery: string; onLink: (l: HcLink | null) => void;
}) {
  const [q, setQ] = useState(defaultQuery);
  const [results, setResults] = useState<HcBook[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [linking, setLinking] = useState<number | null>(null);

  const search = async (query = q) => {
    if (!query.trim()) return;
    setBusy(true);
    try { setResults(await searchBooks(query.trim())); }
    catch (e: any) { toast(e.message, 'err'); }
    finally { setBusy(false); }
  };

  useEffect(() => {
    if (visible && !link) { setQ(defaultQuery); setResults(null); search(defaultQuery); }
  }, [visible]);

  if (link) {
    return (
      <Sheet visible={visible} onClose={onClose} title="Tracking on Hardcover">
        <View style={{ paddingHorizontal: 20, gap: 14 }}>
          <View style={{ flexDirection: 'row', gap: 14, alignItems: 'center' }}>
            {link.image ? <Image source={{ uri: link.image }} style={{ width: 56, height: 84, borderRadius: 6 }} /> : <Cover title={link.title} size={56} radius={6} />}
            <View style={{ flex: 1 }}>
              <Text style={T.title}>{link.title}</Text>
              <Text style={T.body}>{link.authors.join(', ')}</Text>
              <Text style={[T.small, { marginTop: 4 }]}>
                {link.finished ? 'Marked as Read' : link.lastSyncedAt ? `Synced ${fmtTime(link.lastSyncedSeconds ?? 0)} listened` : 'Currently Reading · syncs as you listen'}
                {link.editionId ? '' : ' · no audiobook edition found, syncing estimated time'}
              </Text>
            </View>
          </View>
          {error ? (
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', padding: 10, borderRadius: R.md, backgroundColor: 'rgba(255,107,107,0.12)' }}>
              <Ionicons name="alert-circle" size={16} color={C.danger} />
              <Text style={{ color: C.text, flex: 1, fontSize: 13 }}>Last update to Hardcover failed: {error.message}</Text>
            </View>
          ) : null}
          <Button kind="danger" icon="unlink-outline" label="Stop tracking this book"
            onPress={async () => { await unlink(torrentId); onLink(null); toast('Unlinked from Hardcover'); onClose(); }} />
        </View>
      </Sheet>
    );
  }

  return (
    <Sheet visible={visible} onClose={onClose} title="Match on Hardcover">
      <View style={{ paddingHorizontal: 20, marginBottom: 8 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: C.bg, borderRadius: R.md, borderWidth: 1, borderColor: C.line, paddingHorizontal: 12, height: 48 }}>
          <Ionicons name="search" size={18} color={C.faint} />
          <TextInput value={q} onChangeText={setQ} onSubmitEditing={() => search()} returnKeyType="search" placeholderTextColor={C.faint} accessibilityLabel="Search Hardcover"
            placeholder="Search Hardcover" style={{ flex: 1, color: C.text, marginLeft: 8 }} />
          {busy ? <ActivityIndicator color={C.accent} /> : null}
        </View>
      </View>
      <FlatList
        data={results ?? []}
        keyExtractor={(b) => String(b.id)}
        style={{ maxHeight: 420 }}
        ListEmptyComponent={results && !busy ? <Text style={[T.body, { textAlign: 'center', padding: 24 }]}>No matches. Try the title only.</Text> : null}
        renderItem={({ item }) => (
          <Tap onPress={async () => {
            setLinking(item.id);
            try { const l = await linkBook(torrentId, item); onLink(l); toast('Marked Currently Reading on Hardcover'); onClose(); }
            catch (e: any) { toast(e.message, 'err'); }
            finally { setLinking(null); }
          }} scaleTo={0.99} style={{ flexDirection: 'row', gap: 12, alignItems: 'center', paddingHorizontal: 20, paddingVertical: 8 }}>
            {item.image ? <Image source={{ uri: item.image }} style={{ width: 40, height: 60, borderRadius: 4, backgroundColor: C.elevated }} /> : <Cover title={item.title} size={40} radius={4} />}
            <View style={{ flex: 1 }}>
              <Text numberOfLines={2} style={T.title}>{item.title}</Text>
              <Text numberOfLines={1} style={T.small}>{[item.authors.slice(0, 2).join(', '), item.year].filter(Boolean).join(' · ')}{item.hasAudio ? ' · 🎧' : ''}</Text>
            </View>
            {linking === item.id ? <ActivityIndicator color={C.accent} /> : <Ionicons name="add-circle-outline" size={24} color={C.accent} />}
          </Tap>
        )}
      />
    </Sheet>
  );
}
