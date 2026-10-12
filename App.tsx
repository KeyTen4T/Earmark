import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, AppState, BackHandler, Animated, Easing, Platform, Text, ScrollView } from 'react-native';
import { useLayout, applyDesktopStyles, DESKTOP_GUTTER } from './src/layout';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { C, T, prettyName } from './src/theme';
import { PlayerProvider, usePlayer } from './src/player/PlayerContext';
import { TabBar, MiniPlayer, Sidebar, PlayerBar, Tab, TAB_BAR_HEIGHT, type PlayerBarSheet } from './src/components/Chrome';
import { ToastHost, toast, confirmAction, Sheet, Button } from './src/components/ui';
import { SetupScreen } from './src/screens/SetupScreen';
import { LibraryScreen } from './src/screens/LibraryScreen';
import { DiscoverScreen } from './src/screens/DiscoverScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { PlayerScreen } from './src/screens/PlayerScreen';
import { TBTorrent, listBooks, isReady, isStuck, chapterList } from './src/torbox';
import {
  getApiKey, clearApiKey, loadProgress, loadMeta, saveUserScrapers, bookFraction, loadDisabled, saveDisabled, migrateRemoteBuiltins, loadSettings, takeCorruptKeys,
  loadUpdateCheckedAt, saveUpdateCheckedAt, loadDismissedUpdate, saveDismissedUpdate, loadLastVersion, saveLastVersion,
  loadFavNarrators, saveFavNarrators, loadReadElsewhere,
  Progress, BookMeta,
} from './src/storage';
import { checkForUpdate, startUpdate, clearInstalledUpdates, currentVersion, setKnownUpdate, fetchReleaseNotes } from './src/update';
import { shouldAutoCheck, summary, notesToBlocks, whatsNewDecision, type NoteBlock } from './src/update-check';
import { ADD_POLL_MS, NOT_WAITING, awaitAdded, settleAwaited, stillWaiting } from './src/library-poll';
import { fillMissingCovers } from './src/covers';
import { bookFinishedAt } from './src/shelf';
import type { LibraryBook, ReadElsewhere } from './src/reading-history';
import { initDownloads, cachedBooks } from './src/downloads';
import { initSync, setSyncLibrary, syncNow, onSyncApplied } from './src/sync';
import { reconcilePendingJobs } from './src/readalong/background';
import { BUILTIN_SCRAPERS } from './src/scrapers/builtin';
import type { ScraperDef } from './src/scrapers/engine';
import type { HistoryItem } from './src/recommend';

// Readable names for the stored keys that can go corrupt; anything else is shown as its raw key.
const CORRUPT_LABELS: Record<string, string> = {
  progress: 'progress', settings: 'settings', meta: 'book details', hidden_books: 'hidden books',
  wishlist: 'want to listen', readalong: 'read-alongs', downloads: 'downloads',
  read_elsewhere: 'books read elsewhere',
};

export default function App() {
  const [token, setToken] = useState<string | null | undefined>(undefined);
  useEffect(() => { getApiKey().then((k) => setToken(k ?? null)); }, []);
  // Cross-device sync: read the stored GitHub token, then take a first look at the gist.
  useEffect(() => { void initSync().then(() => syncNow()); }, []);

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <View style={{ flex: 1, backgroundColor: C.bg }}>
        {token === undefined ? null : token === null ? (
          <SetupScreen onDone={setToken} />
        ) : (
          <PlayerProvider token={token}>
            <Shell token={token} onSignOut={async () => { await clearApiKey(); setToken(null); }} />
          </PlayerProvider>
        )}
        <ToastHost />
      </View>
    </SafeAreaProvider>
  );
}

function Shell({ token, onSignOut }: { token: string; onSignOut: () => void }) {
  const insets = useSafeAreaInsets();
  const player = usePlayer();
  const [tab, setTab] = useState<Tab>('library');
  const [playerOpen, setPlayerOpen] = useState(false);
  const [playerSheet, setPlayerSheet] = useState<PlayerBarSheet | undefined>();

  const [books, setBooks] = useState<TBTorrent[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [progress, setProgress] = useState<Record<string, Progress>>({});
  const [meta, setMeta] = useState<Record<string, BookMeta>>({});
  const [lastBookId, setLastBookId] = useState<number | undefined>();
  const [userScrapers, setUserScrapers] = useState<ScraperDef[]>([]);
  const [disabled, setDisabled] = useState<string[]>([]);
  const [narrators, setNarrators] = useState<string[]>([]);
  const [readElsewhere, setReadElsewhere] = useState<ReadElsewhere[]>([]);
  const [whatsNew, setWhatsNew] = useState<{ version: string; blocks: NoteBlock[] } | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const awaited = useRef(NOT_WAITING); // books just sent to TorBox that the list doesn't show yet
  const corruptChecked = useRef(false);
  const updateChecked = useRef(false);

  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setRefreshing(true);
    try {
      const [p, m, s] = await Promise.all([loadProgress(), loadMeta(), loadSettings()]);
      let b: TBTorrent[];
      let usedCache = false;
      try {
        b = await listBooks(token);
      } catch (e: any) {
        // Offline: fall back to the books already downloaded on this device rather than showing empty.
        b = await cachedBooks();
        usedCache = true;
        if (!b.length && !quiet) toast(e.message ?? 'Could not load library', 'err');
      }
      const sorted = b.sort((x, y) => (y.created_at ?? '').localeCompare(x.created_at ?? ''));
      // A transient failure while books are already on screen shouldn't replace them with the smaller cache.
      setBooks((prev) => (usedCache && prev.length ? prev : sorted));
      if (!usedCache) setSyncLibrary(sorted);
      setProgress(p); setMeta(m); setLastBookId(s.lastBookId);
      fillMissingCovers(b, m, setMeta).catch(() => {});
      // Poll while anything is still downloading so it flips to ready on its own.
      if (pollTimer.current) clearTimeout(pollTimer.current);
      // A book that was just added is looked for more often until it shows up.
      if (!usedCache) awaited.current = settleAwaited(awaited.current, b.map((t) => t.hash), Date.now());
      if (stillWaiting(awaited.current, Date.now())) pollTimer.current = setTimeout(() => refresh(true), ADD_POLL_MS);
      else if (!usedCache && b.some((t) => !isReady(t) && !isStuck(t))) pollTimer.current = setTimeout(() => refresh(true), 15000);
    } catch (e: any) {
      if (!quiet) toast(e.message ?? 'Could not load library', 'err');
    } finally {
      setLoaded(true);
      setRefreshing(false);
    }
  }, [token]);

  useEffect(() => {
    refresh(true);
    Promise.all([migrateRemoteBuiltins(), loadDisabled(), loadFavNarrators(), loadReadElsewhere()]).then(([s, d, n, r]) => {
      // An import from before a source became built-in would otherwise show up twice.
      setUserScrapers(s.filter((u) => !BUILTIN_SCRAPERS.some((b) => b.id === u.id)));
      setDisabled(d);
      setNarrators(n);
      setReadElsewhere(r);
    });
    const sub = AppState.addEventListener('change', (st) => { if (st === 'active') { refresh(true); void syncNow(); } });
    return () => { sub.remove(); if (pollTimer.current) clearTimeout(pollTimer.current); };
  }, [refresh]);

  // Once the first load is done, warn about any stored value that could not be read (a copy was kept).
  useEffect(() => {
    if (!loaded || corruptChecked.current) return;
    corruptChecked.current = true;
    const keys = takeCorruptKeys();
    if (!keys.length) return;
    const names = keys.map((k) => CORRUPT_LABELS[k] ?? k).join(', ');
    toast(`Some saved data couldn’t be read and was reset (${names}). A copy was kept.`, 'err');
  }, [loaded]);

  // Once per start, quietly look for a newer release and offer it (unless the user already said Later).
  // First, a version that has not run here shows its release notes once; when it does, the update
  // prompt waits for the next start so the two never appear together.
  const showWhatsNew = async (): Promise<boolean> => {
    const current = currentVersion();
    const action = whatsNewDecision(await loadLastVersion(), current);
    if (action === 'none') return false;
    if (action === 'record') { await saveLastVersion(current); return false; }
    const release = await fetchReleaseNotes(current);
    if (!release) return false; // offline or no tag: leave the stored version so it is tried again
    const blocks = notesToBlocks(release.notes);
    await saveLastVersion(current);
    if (!blocks.length) return false;
    setWhatsNew({ version: current, blocks });
    return true;
  };

  useEffect(() => {
    if (!loaded || updateChecked.current) return;
    updateChecked.current = true;
    clearInstalledUpdates();
    void (async () => {
      if (await showWhatsNew()) return;
      try {
        if (!shouldAutoCheck(await loadUpdateCheckedAt(), Date.now())) return;
        const { release, newer } = await checkForUpdate();
        await saveUpdateCheckedAt(Date.now());
        if (!newer) return;
        setKnownUpdate(release);
        if ((await loadDismissedUpdate()) === release.version) return;
        const body = `${summary(release.notes, 6)}\nYou have ${currentVersion()}.`;
        if (await confirmAction(`Earmark ${release.version} is available`, body, Platform.OS === 'android' ? 'Update' : 'Download')) {
          if (startUpdate(release)) toast('Downloading the update…'); // the install module reports any failure
        } else await saveDismissedUpdate(release.version);
      } catch { /* a failed check is silent */ }
    })();
  }, [loaded]);

  // Offline downloads are device-local; load the queue once the token is known.
  useEffect(() => { void initDownloads(token); }, [token]);

  // Read-alongs building on the server: check on launch and whenever the app comes back.
  useEffect(() => {
    const check = () => { reconcilePendingJobs().catch(() => {}); };
    check();
    const sub = AppState.addEventListener('change', (st) => { if (st === 'active') check(); });
    return () => sub.remove();
  }, []);

  // Sync on first library load, and refresh the on-screen data whenever a sync cycle changes it.
  useEffect(() => { if (loaded) void syncNow(); }, [loaded]);
  useEffect(() => onSyncApplied(() => { void refresh(true); loadProgress().then(setProgress); }), [refresh]);

  // Progress changes while listening; re-read it when returning to the library.
  useEffect(() => { if (tab === 'library' && !playerOpen) loadProgress().then(setProgress); }, [tab, playerOpen]);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (tab !== 'library') { setTab('library'); return true; }
      return false;
    });
    return () => sub.remove();
  }, [tab]);

  // TorBox's list can lag an add by a few seconds; without a second look the new book wouldn't appear.
  const refreshAfterAdd = (hash?: string) => { awaited.current = awaitAdded(awaited.current, hash, Date.now()); refresh(true); };

  // What the listener has and how far they got, for personal recommendations.
  const history = useMemo<HistoryItem[]>(() => books.map((b) => {
    const m = meta[b.hash?.toLowerCase()] ?? {};
    const f = bookFraction(progress[b.id], chapterList(b).map((c) => c.size));
    return { title: m.title ?? prettyName(b.name), author: m.author, status: f >= 1 ? 'finished' : f > 0 ? 'listening' : 'not started', percent: f * 100 };
  }), [books, meta, progress]);

  // The books an import can match against: the same finished books the shelf shows, with the date and
  // rating it would fill only where they are blank.
  const library = useMemo<LibraryBook[]>(() => books.filter(isReady).map((b) => {
    const m = meta[b.hash?.toLowerCase()] ?? {};
    return {
      hash: b.hash,
      title: m.title ?? prettyName(b.name),
      author: m.author,
      finished: !!progress[b.id]?.finished,
      rating: m.rating,
      finishedAt: bookFinishedAt(m, progress[b.id]),
    };
  }), [books, meta, progress]);

  const { wide } = useLayout();
  const [addRequest, setAddRequest] = useState(0); // bumped to ask the library to open its "add a book" sheet
  useEffect(applyDesktopStyles, []);

  // Desktop keyboard: space plays and pauses, the arrows skip. Typing in a field is left alone.
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const onKey = (e: any) => {
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName ?? '') || e.target?.isContentEditable || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.code === 'Space') { e.preventDefault(); player.toggle(); }
      else if (e.code === 'ArrowLeft') player.skip(-player.skipBack);
      else if (e.code === 'ArrowRight') player.skip(player.skipForward);
    };
    (globalThis as any).addEventListener?.('keydown', onKey);
    return () => (globalThis as any).removeEventListener?.('keydown', onKey);
  }, [player.toggle, player.skip, player.skipBack, player.skipForward]);

  const builtins = BUILTIN_SCRAPERS;
  const enabledScrapers = [...builtins, ...userScrapers].filter((s) => !disabled.includes(s.id));
  const miniH = player.book ? 72 : 0;
  // On desktop the navigation and player bar sit beside and below the screens, not on top of them.
  const bottomPad = wide ? 0 : TAB_BAR_HEIGHT + insets.bottom + miniH;

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
     <View style={{ flex: 1, flexDirection: 'row' }}>
      {wide ? <Sidebar tab={tab} onChange={setTab} onAdd={() => { setTab('library'); setAddRequest((n) => n + 1); }} /> : null}
      <View style={{ flex: 1, paddingHorizontal: wide ? DESKTOP_GUTTER : 0 }}>
      <TabPane active={tab === 'library'}>
        <LibraryScreen token={token} books={books} progress={progress} meta={meta} readElsewhere={readElsewhere} refreshing={refreshing} loaded={loaded}
          lastBookId={lastBookId} addRequest={addRequest} bottomPad={bottomPad} refresh={() => refresh()} onAdded={refreshAfterAdd} onOpen={() => { setPlayerSheet(undefined); setPlayerOpen(true); }} onMeta={setMeta} onProgress={setProgress} onReadElsewhere={setReadElsewhere} goDiscover={() => setTab('search')} />
      </TabPane>
      <TabPane active={tab === 'search'}>
        <DiscoverScreen token={token} history={history} scrapers={enabledScrapers} bottomPad={bottomPad} active={tab === 'search'} onAdded={refreshAfterAdd} goSources={() => setTab('sources')}
          narrators={narrators} onNarrators={(l) => { setNarrators(l); saveFavNarrators(l); }} />
      </TabPane>
      <TabPane active={tab === 'sources'}>
        <SettingsScreen builtins={builtins} userScrapers={userScrapers} disabled={disabled} bottomPad={bottomPad}
          narrators={narrators}
          library={library} readElsewhere={readElsewhere}
          onNarrators={(l) => { setNarrators(l); saveFavNarrators(l); }}
          onScrapers={(s) => { setUserScrapers(s); saveUserScrapers(s); }}
          onDisabled={(d) => { setDisabled(d); saveDisabled(d); }}
          onReadElsewhere={setReadElsewhere}
          onImported={() => { void refresh(true); }}
          onSignOut={() => { player.stop(); onSignOut(); }} />
      </TabPane>

      </View>
     </View>

      {wide ? <PlayerBar onOpen={(sheet) => { setPlayerSheet(sheet); setPlayerOpen(true); }} /> : (
        <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0 }}>
          <MiniPlayer onOpen={() => { setPlayerSheet(undefined); setPlayerOpen(true); }} />
          <TabBar tab={tab} onChange={setTab} />
        </View>
      )}

      <PlayerScreen visible={playerOpen && !!player.book} openSheet={playerSheet} onSheetOpened={() => setPlayerSheet(undefined)}
        onClose={() => { setPlayerOpen(false); setPlayerSheet(undefined); }} onMeta={setMeta} />

      <Sheet visible={!!whatsNew} onClose={() => setWhatsNew(null)} title={`What's new in ${whatsNew?.version ?? ''}`}>
        <ScrollView style={{ paddingHorizontal: 20 }} contentContainerStyle={{ gap: 10, paddingBottom: 12 }}>
          {(whatsNew?.blocks ?? []).map((b, i) => b.kind === 'label' ? (
            <Text key={i} style={[T.label, { color: C.accent, marginTop: 4 }]}>{b.text}</Text>
          ) : b.kind === 'bullet' ? (
            <View key={i} style={{ flexDirection: 'row', gap: 8 }}>
              <Text style={[T.body, { color: C.faint }]}>•</Text>
              <Text style={[T.body, { flex: 1 }]}>
                {b.lead ? <Text style={{ color: C.text, fontWeight: '700' }}>{b.lead}</Text> : null}{b.lead && b.text ? ' ' : ''}{b.text}
              </Text>
            </View>
          ) : (
            <Text key={i} style={T.body}>{b.text}</Text>
          ))}
          <Button label="Done" onPress={() => setWhatsNew(null)} />
        </ScrollView>
      </Sheet>
    </View>
  );
}

/** One tab's screen. All three stay mounted; the one being switched to fades and rises into place. */
function TabPane({ active, children }: { active: boolean; children: React.ReactNode }) {
  const v = useRef(new Animated.Value(active ? 1 : 0)).current;
  useEffect(() => {
    if (!active) return;
    v.setValue(0);
    Animated.timing(v, { toValue: 1, duration: 240, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [active]);
  return (
    <Animated.View style={{ flex: 1, display: active ? 'flex' : 'none', opacity: v, transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) }] }}>
      {children}
    </Animated.View>
  );
}
