import React, { useEffect, useMemo, useState } from 'react';
import * as DocumentPicker from 'expo-document-picker';
import { View, Text, RefreshControl, TextInput, Animated, Platform } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { C, R, T, paletteFor, fmtApprox, prettyName } from '../theme';
import { Tap, Cover, Bar, Chip, ChipRow, Sheet, Empty, Button, IconButton, toast, FadeIn, Pop, Skeleton, HeroHeader, StickyBar, useScrollY, confirmAction, type IconName } from '../components/ui';
import { TBTorrent, isReady, isStuck, chapterList, addMagnet, deleteTorrent } from '../torbox';
import { Progress, BookMeta, bookFraction, loadHiddenBooks, saveHiddenBooks, saveMeta, saveProgress, saveReadElsewhere, removeReadElsewhere } from '../storage';
import { remainingBookSeconds } from '../book-math';
import { onSyncApplied, syncAfterProgress } from '../sync';
import { formatBytes } from '../scrapers/template';
import { usePlayer } from '../player/PlayerContext';
import { CoverPicker } from '../components/CoverPicker';
import { useLayout } from '../layout';
import { torrentToMagnet } from '../scrapers/bencode';
import { getDownloads, subscribeDownloads, queueBook, pauseDownload, resumeDownload, removeDownload } from '../downloads';
import { progressFraction, isComplete, type DownloadBook, type Downloads } from '../downloads/state';
import { matchesLibrarySearch } from '../library-search';
import { bookFinishedAt, entryFinishedAt, formatFinishedDate, ratingAfterTap, shelfGroups } from '../shelf';
import { syncRating } from '../hardcover';
import type { ReadElsewhere } from '../reading-history';

type Filter = 'all' | 'listening' | 'new' | 'done';

export function LibraryScreen(props: {
  token: string;
  books: TBTorrent[];
  progress: Record<string, Progress>;
  meta: Record<string, BookMeta>;
  readElsewhere: ReadElsewhere[];
  refreshing: boolean;
  loaded: boolean;
  lastBookId?: number;
  addRequest?: number; // changes when something outside the screen asks for the add sheet
  bottomPad: number;
  refresh: () => void;
  onAdded: (hash?: string) => void; // a book was just sent to TorBox: look for it until it is listed
  onOpen: (b: TBTorrent) => void;
  onMeta: (all: Record<string, BookMeta>) => void;
  onProgress: (all: Record<string, Progress>) => void;
  onReadElsewhere: (list: ReadElsewhere[]) => void;
  goDiscover: () => void;
}) {
  const { progress, meta, refreshing, refresh, onOpen } = props;
  const insets = useSafeAreaInsets();
  const { wide, contentWidth } = useLayout();
  const player = usePlayer();
  // Offline downloads for this device. On the desktop/web build nothing is ever recorded, so the
  // indicators and menu entries below stay hidden.
  const [downloads, setDownloads] = useState<Downloads>(() => getDownloads());
  useEffect(() => subscribeDownloads(setDownloads), []);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const { y, onScroll } = useScrollY();
  const [addOpen, setAddOpen] = useState(false);
  useEffect(() => { if (props.addRequest) setAddOpen(true); }, [props.addRequest]);
  const [menu, setMenu] = useState<TBTorrent | null>(null);
  const [elsewhereMenu, setElsewhereMenu] = useState<ReadElsewhere | null>(null);
  const [coverFor, setCoverFor] = useState<TBTorrent | null>(null);
  const [editFor, setEditFor] = useState<TBTorrent | null>(null);
  const [showStuck, setShowStuck] = useState(false);
  // Books being removed. TorBox can keep listing one for a few seconds after confirming the delete.
  const [removing, setRemoving] = useState<number[]>([]);
  const books = props.books.filter((b) => !removing.includes(b.id));

  // Books moved out of the main library. They stay in TorBox and sit in the Hidden section below.
  const [hiddenHashes, setHiddenHashes] = useState<string[]>([]);
  const [showHidden, setShowHidden] = useState(false);
  useEffect(() => { loadHiddenBooks().then(setHiddenHashes); }, []);
  // A sync from another device may have hidden or unhidden books.
  useEffect(() => onSyncApplied(() => { loadHiddenBooks().then(setHiddenHashes); }), []);
  const isHidden = (b: TBTorrent) => hiddenHashes.includes(b.hash?.toLowerCase());
  const setBookHidden = (b: TBTorrent, hide: boolean) => {
    const hash = b.hash?.toLowerCase();
    if (!hash) return;
    const next = hide ? [...hiddenHashes.filter((h) => h !== hash), hash] : hiddenHashes.filter((h) => h !== hash);
    setHiddenHashes(next);
    saveHiddenBooks(next);
  };
  const shelf = books.filter((b) => !isHidden(b));
  const hiddenBooks = books.filter(isHidden);

  const remove = async (b: TBTorrent) => {
    const unhide = () => setRemoving((h) => h.filter((id) => id !== b.id));
    if (player.book?.id === b.id) player.stop();
    setRemoving((h) => [...h, b.id]);
    try {
      await deleteTorrent(props.token, b.id);
      toast('Removed');
      refresh();
      setTimeout(refresh, 6000);
      setTimeout(unhide, 20000); // if TorBox somehow still has it by then, show it again
    } catch (e: any) {
      unhide();
      console.warn(`Remove failed for torrent ${b.id} (${b.download_state}):`, e?.message ?? e);
      // Don't leave a book TorBox won't delete sitting on the shelf: put it in Hidden instead.
      if (!isHidden(b) && b.hash) {
        setBookHidden(b, true);
        toast('TorBox wouldn’t delete it, so it’s been moved to Hidden', 'err');
      } else {
        toast(`Couldn’t remove: ${e?.message ?? 'unknown error'}`, 'err');
      }
      refresh();
    }
  };

  // "Mark as finished" points at the last chapter, keeping any position/duration already stored;
  // "not finished" keeps the record but rewinds it to chapter 0. Progress needs the same explicit
  // sync nudge the player uses when it pauses or finishes, since saving alone does not emit a change.
  const setFinished = async (b: TBTorrent, finished: boolean) => {
    const chapters = chapterList(b);
    const prev = progress[b.id];
    const index = finished ? Math.max(0, chapters.length - 1) : 0;
    const p: Progress = {
      fileId: chapters[index]?.id ?? prev?.fileId ?? 0,
      chapterIndex: index,
      chapterCount: chapters.length || prev?.chapterCount || 0,
      position: finished ? prev?.position ?? 0 : 0,
      duration: finished ? prev?.duration ?? 0 : 0,
      updated: Date.now(),
      finished,
    };
    await saveProgress(b.id, p);
    props.onProgress({ ...progress, [b.id]: p });
    if (b.hash) props.onMeta(await saveMeta(b.hash, { finishedAt: finished ? Date.now() : undefined }));
    syncAfterProgress(true);
    toast(finished ? 'Marked as finished' : 'Marked as not finished');
  };

  // A tap on a star sets or clears the book's own rating. The local change is saved and shown at
  // once; a linked Hardcover book is pushed in the background.
  const rate = async (b: TBTorrent, star: number) => {
    if (!b.hash) return;
    const next = ratingAfterTap(m(b).rating, star);
    props.onMeta(await saveMeta(b.hash, { rating: next }));
    void syncRating(b.id, next ?? null);
  };

  // A "read elsewhere" entry's rating lives only in the device-local shelf list; the tap rule is the
  // same as a library book's, but nothing is pushed anywhere.
  const rateElsewhere = async (e: ReadElsewhere, star: number) => {
    const next = ratingAfterTap(e.rating, star);
    const updated = props.readElsewhere.map((x) => (x.id === e.id ? { ...x, rating: next } : x));
    await saveReadElsewhere(updated);
    props.onReadElsewhere(updated);
  };
  // Removes the entry and remembers its id, so a later import does not bring it back.
  const removeElsewhere = async (e: ReadElsewhere) => {
    setElsewhereMenu(null);
    await removeReadElsewhere(e.id);
    props.onReadElsewhere(props.readElsewhere.filter((x) => x.id !== e.id));
    toast('Removed from shelf');
  };

  const ready = shelf.filter(isReady);
  const downloading = shelf.filter((b) => !isReady(b) && !isStuck(b));
  const stuck = shelf.filter(isStuck);
  const m = (b: TBTorrent) => meta[b.hash?.toLowerCase()] ?? {};

  // One spoken description for a library card: title, author, then how far along it is.
  const cardLabel = (b: TBTorrent): string => {
    const md = meta[b.hash?.toLowerCase()] ?? {};
    const bits = [md.title ?? prettyName(b.name)];
    if (md.author) bits.push(md.author);
    const p = progress[b.id];
    if (p?.finished) bits.push('finished');
    else if (player.book?.id === b.id) bits.push('now playing');
    else if (p) bits.push(`${Math.round(bookFraction(p, chapterList(b).map((f) => f.size)) * 100)}% listened`);
    return bits.join(', ');
  };

  const hero = useMemo(() => {
    const byRecent = ready
      .filter((b) => progress[b.id] && !progress[b.id].finished)
      .sort((a, b) => progress[b.id].updated - progress[a.id].updated);
    return ready.find((b) => b.id === props.lastBookId && !progress[b.id]?.finished) ?? byRecent[0];
  }, [ready, progress, props.lastBookId]);
  const heroSizes = hero ? chapterList(hero).map((f) => f.size) : [];
  const heroLeft = hero && progress[hero.id] && !progress[hero.id].finished
    ? remainingBookSeconds(heroSizes, progress[hero.id].chapterIndex, progress[hero.id].position, progress[hero.id].duration, progress[hero.id].chapterCount)
    : null;

  const filtered = ready.filter((b) => {
    const p = progress[b.id];
    if (filter === 'listening') return p && !p.finished;
    if (filter === 'new') return !p;
    if (filter === 'done') return p?.finished;
    return true;
  });
  // The search narrows whatever the chip already selected; titles, authors and narrators all match.
  const q = query.trim();
  const shown = q ? filtered.filter((b) => matchesLibrarySearch(b.name, meta[b.hash?.toLowerCase()], q)) : filtered;
  // The Finished chip shows the shelf: finished library books and "read elsewhere" entries together,
  // in the same year groups. Elsewhere entries appear only here, never in the other filters or counts.
  type FinishedItem =
    | { kind: 'book'; book: TBTorrent; finishedAt?: number }
    | { kind: 'elsewhere'; entry: ReadElsewhere; finishedAt?: number };
  const bookItems: FinishedItem[] = shown.map((book) => ({
    kind: 'book', book, finishedAt: bookFinishedAt(meta[book.hash?.toLowerCase() ?? ''], progress[book.id]),
  }));
  const entryItems: FinishedItem[] = filter === 'done'
    ? props.readElsewhere
        .filter((e) => !q || `${e.title} ${e.author ?? ''}`.toLowerCase().includes(q.toLowerCase()))
        .map((entry) => ({ kind: 'elsewhere', entry, finishedAt: entryFinishedAt(entry) }))
    : [];
  const finishedItems = [...bookItems, ...entryItems];
  const finishedGroups = shelfGroups(finishedItems);

  // Two covers across on a phone; on desktop as many ~190px covers as fit. Measure the grid instead
  // of trusting contentWidth: the screen's own scrollbar takes a slice of the width it reports, so
  // an exact-fit row would otherwise wrap its last column and leave a gap on the right.
  const gap = wide ? 20 : 14;
  const [gridW, setGridW] = useState(0);
  const avail = wide && gridW ? gridW : contentWidth;
  const cols = wide ? Math.max(2, Math.floor((avail - 40 + gap) / (190 + gap))) : 2;
  const col = Math.floor((avail - 20 * 2 - gap * (cols - 1)) / cols);
  const hour = new Date().getHours();
  const greet = hour < 5 ? 'Late night listening' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  // The book whose options sheet is open, and its download state / on-disk size.
  const menuDl = menu ? downloads[menu.hash?.toLowerCase() ?? ''] : undefined;
  const menuBytes = menu ? chapterList(menu).reduce((n, f) => n + f.size, 0) : 0;

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Animated.ScrollView onScroll={onScroll} scrollEventThrottle={16}
        contentContainerStyle={{ paddingTop: insets.top + (wide ? 28 : 12), paddingBottom: props.bottomPad + 24 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={C.accent} colors={[C.accent]} progressBackgroundColor={C.elevated} />}
      >
        <HeroHeader y={y} label={greet} title="Library" style={{ paddingHorizontal: 20, marginBottom: 18 }}
          right={<IconButton label="Add a book" name="add" bg={C.elevated} onPress={() => setAddOpen(true)} />} />

        {!props.loaded ? (
          <View style={{ paddingHorizontal: 20 }} onLayout={(e) => setGridW(e.nativeEvent.layout.width)}>
            <Skeleton height={148} radius={R.xl} style={{ marginBottom: 26 }} />
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap }}>
              {[0, 1, 2, 3].map((i) => <Skeleton key={i} width={col} height={col} style={{ marginBottom: 8 }} />)}
            </View>
          </View>
        ) : books.length === 0 && props.readElsewhere.length === 0 ? (
          <Empty icon="headset-outline" title="Nothing on the shelf yet"
            body="Find a book in Discover, or add a magnet link with the + button. Anything with audio files in your TorBox shows up here."
            action={<Button label="Discover books" icon="search" onPress={props.goDiscover} />} />
        ) : (
          <>
            {hero && (
              <FadeIn>
              <Tap haptic onPress={() => { onOpen(hero); player.open(hero, m(hero), { autoplay: true }); }} onMenu={() => setMenu(hero)} scaleTo={0.98}
                accessibilityLabel={cardLabel(hero)} accessibilityHint="Long press for options"
                style={{ marginHorizontal: 20, borderRadius: R.xl, overflow: 'hidden', marginBottom: 26, maxWidth: 640 }}>
                <LinearGradient colors={[paletteFor(hero.name)[1], C.surface]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ padding: 18, flexDirection: 'row', gap: 16 }}>
                  <Cover title={hero.name} uri={m(hero).cover} size={112} radius={R.md} style={{ shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 12, elevation: 10 }} />
                  <View style={{ flex: 1, justifyContent: 'space-between' }}>
                    <View>
                      <Text style={[T.label, { color: 'rgba(255,255,255,0.7)' }]}>Continue listening</Text>
                      <Text numberOfLines={2} style={[T.h2, { marginTop: 6 }]}>{m(hero).title ?? prettyName(hero.name)}</Text>
                      {m(hero).author ? <Text numberOfLines={1} style={[T.body, { marginTop: 2 }]}>{m(hero).author}</Text> : null}
                    </View>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                      <View style={{ flex: 1, gap: 6 }}>
                        <Bar value={bookFraction(progress[hero.id], heroSizes)} />
                        <Text numberOfLines={1} style={T.small}>
                          {progress[hero.id] ? `Chapter ${progress[hero.id].chapterIndex + 1} of ${progress[hero.id].chapterCount}` : 'Not started'}
                          {heroLeft != null ? ` · About ${fmtApprox(heroLeft)} left` : ''}
                        </Text>
                      </View>
                      <View style={{ width: 46, height: 46, borderRadius: 23, backgroundColor: C.text, alignItems: 'center', justifyContent: 'center' }}>
                        <Pop on={player.book?.id === hero.id && player.playing} from={0.6}>
                          <Ionicons name={player.book?.id === hero.id && player.playing ? 'pause' : 'play'} size={22} color={C.bg} style={{ marginLeft: 2 }} />
                        </Pop>
                      </View>
                    </View>
                  </View>
                  <Tap onPress={(e) => { e.stopPropagation(); setMenu(hero); }} hitSlop={10} scaleTo={0.85} accessibilityLabel={`Options for ${m(hero).title ?? prettyName(hero.name)}`}
                    style={{ position: 'absolute', top: 6, right: 6, padding: 6 }}>
                    <Ionicons name="ellipsis-horizontal" size={18} color={C.sub} />
                  </Tap>
                </LinearGradient>
              </Tap>
              </FadeIn>
            )}

            {downloading.length > 0 && (
              <View style={{ marginBottom: 22, maxWidth: wide ? 720 : undefined }}>
                <Text style={[T.label, { paddingHorizontal: 20, marginBottom: 10 }]}>Preparing in TorBox</Text>
                {downloading.map((b) => (
                  <Tap key={b.id} onMenu={() => setMenu(b)} style={{ marginHorizontal: 20, marginBottom: 8, padding: 12, borderRadius: R.md, backgroundColor: C.surface, flexDirection: 'row', gap: 12, alignItems: 'center' }}>
                    <Cover title={b.name} uri={m(b).cover} size={44} radius={8} />
                    <View style={{ flex: 1, gap: 6 }}>
                      <Text numberOfLines={1} style={T.title}>{m(b).title ?? prettyName(b.name)}</Text>
                      <Bar value={b.progress ?? 0} height={3} />
                      <Text style={T.small}>
                        {Math.round((b.progress ?? 0) * 100)}% · {b.download_state ?? 'queued'}
                        {b.download_speed ? ` · ${formatBytes(b.download_speed)}/s` : ''}
                      </Text>
                    </View>
                  </Tap>
                ))}
              </View>
            )}

            {stuck.length > 0 && (
              <View style={{ marginBottom: 22, maxWidth: wide ? 720 : undefined }}>
                <Tap onPress={() => setShowStuck((v) => !v)} scaleTo={0.99} style={{ marginHorizontal: 20, padding: 12, borderRadius: R.md, backgroundColor: C.surface, flexDirection: 'row', gap: 10, alignItems: 'center' }}>
                  <Ionicons name="alert-circle-outline" size={18} color={C.sub} />
                  <Text style={[T.body, { flex: 1 }]}>{stuck.length} unavailable in TorBox</Text>
                  <Ionicons name={showStuck ? 'chevron-up' : 'chevron-down'} size={16} color={C.faint} />
                </Tap>
                {showStuck && stuck.map((b) => (
                  <Tap key={b.id} onPress={() => setMenu(b)} onMenu={() => setMenu(b)} style={{ marginHorizontal: 20, marginTop: 8, padding: 12, borderRadius: R.md, backgroundColor: C.surface, flexDirection: 'row', gap: 12, alignItems: 'center', opacity: 0.75 }}>
                    <Cover title={b.name} uri={m(b).cover} size={44} radius={8} />
                    <View style={{ flex: 1, gap: 3 }}>
                      <Text numberOfLines={1} style={T.title}>{m(b).title ?? prettyName(b.name)}</Text>
                      <Text style={T.small}>{b.download_state} · tap to remove or change cover</Text>
                    </View>
                  </Tap>
                ))}
              </View>
            )}

            {shelf.length > 8 && (
              <View style={{ paddingHorizontal: 20, marginBottom: 14, maxWidth: 720 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: C.surface, borderRadius: R.lg, borderWidth: 1, borderColor: C.line, paddingHorizontal: 14, height: 54 }}>
                  <Ionicons name="search" size={20} color={C.faint} />
                  <TextInput value={query} onChangeText={setQuery} returnKeyType="search" accessibilityLabel="Search your library"
                    placeholder="Search your library" placeholderTextColor={C.faint}
                    style={{ flex: 1, color: C.text, fontSize: 16, marginLeft: 10 }} />
                  {query ? (
                    <Tap onPress={() => setQuery('')} hitSlop={10} accessibilityLabel="Clear search"><Ionicons name="close-circle" size={20} color={C.faint} /></Tap>
                  ) : null}
                </View>
              </View>
            )}

            <ChipRow style={{ marginBottom: 18 }}>
              {([['all', 'All'], ['listening', 'In progress'], ['new', 'Not started'], ['done', 'Finished']] as [Filter, string][]).map(([k, l]) => (
                <Chip key={k} label={l} active={filter === k} onPress={() => setFilter(k)} />
              ))}
            </ChipRow>

            {filter === 'done' ? (
              finishedItems.length === 0 ? (
                <Text style={[T.body, { textAlign: 'center', marginTop: 30 }]}>{q ? `Nothing matches “${q}”.` : 'No finished books yet.'}</Text>
              ) : (
                <View style={{ paddingHorizontal: 20, maxWidth: wide ? 720 : undefined }}>
                  {finishedGroups.map((g) => (
                    <View key={g.year ?? 'earlier'} style={{ marginBottom: 22 }}>
                      <Text style={[T.label, { marginBottom: 10 }]}>{g.label}</Text>
                      {g.books.map((e, i) => (
                        e.kind === 'book' ? (
                          <FadeIn key={`b${e.book.id}`} index={i} delay={80}>
                            <FinishedRow book={e.book} meta={m(e.book)} finishedAt={e.finishedAt}
                              onOpen={() => { onOpen(e.book); player.open(e.book, m(e.book), { autoplay: true }); }}
                              onMenu={() => setMenu(e.book)}
                              onRate={(star) => rate(e.book, star)} />
                          </FadeIn>
                        ) : (
                          <FadeIn key={e.entry.id} index={i} delay={80}>
                            <ElsewhereRow entry={e.entry} onMenu={() => setElsewhereMenu(e.entry)} onRate={(star) => rateElsewhere(e.entry, star)} />
                          </FadeIn>
                        )
                      ))}
                    </View>
                  ))}
                </View>
              )
            ) : shown.length === 0 ? (
              <Text style={[T.body, { textAlign: 'center', marginTop: 30 }]}>{q ? `Nothing matches “${q}”.` : 'Nothing here yet.'}</Text>
            ) : (
              <View key={filter} style={{ flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 20, gap }} onLayout={(e) => setGridW(e.nativeEvent.layout.width)}>
                {shown.map((b, i) => {
                  const p = progress[b.id];
                  const md = m(b);
                  const playing = player.book?.id === b.id;
                  const dl = downloads[b.hash?.toLowerCase() ?? ''];
                  const sizes = chapterList(b).map((f) => f.size);
                  const left = p && !p.finished ? remainingBookSeconds(sizes, p.chapterIndex, p.position, p.duration, p.chapterCount) : null;
                  return (
                    <FadeIn key={b.id} index={i} delay={80} style={{ width: col, marginBottom: 8 }}>
                    <Tap haptic onPress={() => { onOpen(b); player.open(b, md, { autoplay: true }); }} onMenu={() => setMenu(b)} accessibilityLabel={cardLabel(b)} accessibilityHint="Long press for options" hoverStyle={{ backgroundColor: C.hover, borderRadius: R.md }}>
                      <View>
                        <Cover title={b.name} uri={md.cover} size={col} radius={R.md} />
                        {p?.finished && (
                          <View style={{ position: 'absolute', top: 8, right: 8, backgroundColor: 'rgba(0,0,0,0.65)', borderRadius: R.pill, paddingHorizontal: 8, paddingVertical: 4, flexDirection: 'row', gap: 4, alignItems: 'center' }}>
                            <Ionicons name="checkmark" size={12} color={C.good} /><Text style={{ color: C.text, fontSize: 11, fontWeight: '700' }}>Done</Text>
                          </View>
                        )}
                        {playing && (
                          <View style={{ position: 'absolute', bottom: 8, left: 8, backgroundColor: C.accent, borderRadius: R.pill, paddingHorizontal: 8, paddingVertical: 4, flexDirection: 'row', gap: 4, alignItems: 'center' }}>
                            <Ionicons name="volume-high" size={12} color={C.accentInk} /><Text style={{ color: C.accentInk, fontSize: 11, fontWeight: '800' }}>Now playing</Text>
                          </View>
                        )}
                        {Platform.OS !== 'web' && dl ? <DownloadMark rec={dl} /> : null}
                      </View>
                      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 2, marginTop: 10 }}>
                        <Text numberOfLines={2} style={[T.title, { flex: 1, fontSize: 14 }]}>{md.title ?? prettyName(b.name)}</Text>
                        <Tap onPress={(e) => { e.stopPropagation(); setMenu(b); }} hitSlop={10} scaleTo={0.85} accessibilityLabel={`Options for ${md.title ?? prettyName(b.name)}`} style={{ padding: 4, marginVertical: -4 }}>
                          <Ionicons name="ellipsis-horizontal" size={18} color={C.sub} />
                        </Tap>
                      </View>
                      <Text numberOfLines={1} style={[T.small, { marginTop: 3 }]}>
                        {md.author ?? `${chapterList(b).length} chapter${chapterList(b).length === 1 ? '' : 's'} · ${formatBytes(b.size)}`}
                      </Text>
                      {p && !p.finished ? <View style={{ marginTop: 8 }}><Bar value={bookFraction(p, sizes)} height={3} /></View> : null}
                      {left != null ? <Text numberOfLines={1} style={[T.small, { marginTop: 4 }]}>About {fmtApprox(left)} left</Text> : null}
                    </Tap>
                    </FadeIn>
                  );
                })}
              </View>
            )}

            {hiddenBooks.length > 0 && (
              <View style={{ marginTop: 28, maxWidth: wide ? 720 : undefined }}>
                <Tap onPress={() => setShowHidden((v) => !v)} scaleTo={0.99} style={{ marginHorizontal: 20, padding: 12, borderRadius: R.md, backgroundColor: C.surface, flexDirection: 'row', gap: 10, alignItems: 'center' }}>
                  <Ionicons name="eye-off-outline" size={18} color={C.sub} />
                  <Text style={[T.body, { flex: 1 }]}>Hidden · {hiddenBooks.length}</Text>
                  <Ionicons name={showHidden ? 'chevron-up' : 'chevron-down'} size={16} color={C.faint} />
                </Tap>
                {showHidden && hiddenBooks.map((b) => (
                  <Tap key={b.id} onPress={() => setMenu(b)} onMenu={() => setMenu(b)} style={{ marginHorizontal: 20, marginTop: 8, padding: 12, borderRadius: R.md, backgroundColor: C.surface, flexDirection: 'row', gap: 12, alignItems: 'center' }}>
                    <Cover title={b.name} uri={m(b).cover} size={44} radius={8} />
                    <View style={{ flex: 1, gap: 3 }}>
                      <Text numberOfLines={1} style={T.title}>{m(b).title ?? prettyName(b.name)}</Text>
                      <Text numberOfLines={1} style={T.small}>{isReady(b) ? `${chapterList(b).length} chapter${chapterList(b).length === 1 ? '' : 's'} · ${formatBytes(b.size)}` : b.download_state ?? 'not ready'}</Text>
                    </View>
                    <Tap onPress={() => { setBookHidden(b, false); toast('Moved back to library'); }} hitSlop={8} scaleTo={0.85} accessibilityLabel={`Unhide ${m(b).title ?? prettyName(b.name)}`} style={{ padding: 6 }}>
                      <Ionicons name="eye-outline" size={20} color={C.accent} />
                    </Tap>
                  </Tap>
                ))}
              </View>
            )}
          </>
        )}
      </Animated.ScrollView>
      <StickyBar y={y} title="Library" />

      <AddMagnetSheet visible={addOpen} onClose={() => setAddOpen(false)} token={props.token} onAdded={props.onAdded} />

      <Sheet visible={!!menu} onClose={() => setMenu(null)} title={menu ? m(menu).title ?? prettyName(menu.name) : ''}>
        {menu && (
          <View style={{ paddingHorizontal: 20, gap: 10, paddingTop: 6 }}>
            {isReady(menu) && (
              <Button kind="ghost" icon="play-skip-back" label="Play from the beginning"
                onPress={() => { const b = menu; setMenu(null); onOpen(b); player.open(b, m(b), { autoplay: true, chapter: 0 }); }} />
            )}
            <Button kind="ghost" icon="image-outline" label="Change cover" onPress={() => { const b = menu; setMenu(null); setCoverFor(b); }} />
            <Button kind="ghost" icon="create-outline" label="Edit details" onPress={() => { const b = menu; setMenu(null); setEditFor(b); }} />
            {isReady(menu) && player.book?.id !== menu.id && (
              progress[menu.id]?.finished ? (
                <Button kind="ghost" icon="arrow-undo-outline" label="Mark as not finished"
                  onPress={() => { const b = menu; setMenu(null); void setFinished(b, false); }} />
              ) : (
                <Button kind="ghost" icon="checkmark-done-outline" label="Mark as finished"
                  onPress={() => { const b = menu; setMenu(null); void setFinished(b, true); }} />
              )
            )}
            {Platform.OS !== 'web' && (menuDl ? (
              <>
                {(menuDl.status === 'downloading' || menuDl.status === 'queued') && (
                  <Button kind="ghost" icon="pause-outline" label="Pause download"
                    onPress={() => { const b = menu; setMenu(null); pauseDownload(b.hash); toast('Download paused'); }} />
                )}
                {(menuDl.status === 'paused' || menuDl.status === 'failed') && (
                  <Button kind="ghost" icon="cloud-download-outline" label="Resume download"
                    onPress={() => { const b = menu; setMenu(null); resumeDownload(b.hash); toast('Resuming download'); }} />
                )}
                {menuDl.status === 'failed' && menuDl.error ? (
                  <Text style={[T.small, { color: C.danger, paddingHorizontal: 4 }]}>{menuDl.error}</Text>
                ) : null}
                <Button kind="danger" icon="trash-outline" label="Remove download"
                  onPress={() => { const b = menu; setMenu(null); void removeDownload(b.hash).then(() => toast('Download removed')).catch((e: any) => toast(e?.message ?? 'Could not remove', 'err')); }} />
              </>
            ) : (
              <Button kind="ghost" icon="cloud-download-outline" label={`Download · ${formatBytes(menuBytes)}`}
                onPress={() => { const b = menu; setMenu(null); void queueBook(b).then(() => toast('Download started')).catch((e: any) => toast(e?.message ?? 'Could not download', 'err')); }} />
            ))}
            {isHidden(menu) ? (
              <Button kind="ghost" icon="eye-outline" label="Move back to library"
                onPress={() => { const b = menu; setMenu(null); setBookHidden(b, false); toast('Moved back to library'); }} />
            ) : (
              <Button kind="ghost" icon="eye-off-outline" label="Hide from library"
                onPress={() => { const b = menu; setMenu(null); setBookHidden(b, true); toast('Moved to Hidden, at the bottom of the library'); }} />
            )}
            <Button kind="danger" icon="trash-outline" label="Remove from TorBox"
              onPress={async () => {
                const b = menu;
                if (!(await confirmAction('Remove from TorBox?', `“${m(b).title ?? prettyName(b.name)}” will be deleted from your TorBox account. You would have to add it again to listen to it.`, 'Remove'))) return;
                setMenu(null); remove(b);
              }} />
          </View>
        )}
      </Sheet>

      <Sheet visible={!!elsewhereMenu} onClose={() => setElsewhereMenu(null)} title={elsewhereMenu?.title ?? ''}>
        {elsewhereMenu && (
          <View style={{ paddingHorizontal: 20, gap: 10, paddingTop: 6 }}>
            <Text style={T.small}>Read elsewhere · not in your TorBox library, so there is nothing to play.</Text>
            <Button kind="danger" icon="trash-outline" label="Remove from shelf" onPress={() => void removeElsewhere(elsewhereMenu)} />
          </View>
        )}
      </Sheet>

      {coverFor && <CoverPicker visible onClose={() => setCoverFor(null)} book={coverFor} meta={m(coverFor)} onSaved={props.onMeta} />}
      {editFor && <EditDetailsSheet visible onClose={() => setEditFor(null)} book={editFor} meta={m(editFor)} onSaved={props.onMeta} />}
    </View>
  );
}

function EditDetailsSheet({ visible, onClose, book, meta, onSaved }: {
  visible: boolean; onClose: () => void; book: TBTorrent; meta: BookMeta; onSaved: (all: Record<string, BookMeta>) => void;
}) {
  const player = usePlayer();
  const [title, setTitle] = useState(meta.title ?? '');
  const [author, setAuthor] = useState(meta.author ?? '');
  const [narrator, setNarrator] = useState(meta.narrator ?? '');
  const save = async () => {
    const t = title.trim() || undefined;
    const a = author.trim() || undefined;
    const n = narrator.trim() || undefined;
    try {
      const all = await saveMeta(book.hash, { title: t, author: a, narrator: n });
      player.updateMeta(book.id, { title: t, author: a, narrator: n });
      onSaved(all);
      toast('Details saved');
      onClose();
    } catch (e: any) {
      toast(e.message ?? 'Could not save details', 'err');
    }
  };
  return (
    <Sheet visible={visible} onClose={onClose} title="Edit details">
      <View style={{ paddingHorizontal: 20, gap: 12, paddingTop: 4 }}>
        <LabeledInput label="Title" value={title} onChangeText={setTitle} placeholder={prettyName(book.name)} />
        <LabeledInput label="Author" value={author} onChangeText={setAuthor} placeholder="Author" />
        <LabeledInput label="Narrator" value={narrator} onChangeText={setNarrator} placeholder="Narrator" />
        <Button label="Save" icon="save-outline" onPress={save} />
      </View>
    </Sheet>
  );
}

function LabeledInput({ label, value, onChangeText, placeholder }: {
  label: string; value: string; onChangeText: (v: string) => void; placeholder: string;
}) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={T.label}>{label}</Text>
      <TextInput value={value} onChangeText={onChangeText} placeholder={placeholder} placeholderTextColor={C.faint} accessibilityLabel={label}
        style={{ backgroundColor: C.bg, color: C.text, borderRadius: R.md, padding: 14, borderWidth: 1, borderColor: C.line }} />
    </View>
  );
}

function AddMagnetSheet({ visible, onClose, token, onAdded }: { visible: boolean; onClose: () => void; token: string; onAdded: (hash?: string) => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const add = async () => {
    const v = text.trim();
    if (!/^magnet:\?/i.test(v)) return toast('That doesn’t look like a magnet link', 'err');
    setBusy(true);
    try { const res = await addMagnet(token, v); toast('Sent to TorBox'); setText(''); onClose(); onAdded(res?.hash); }
    catch (e: any) { toast(e.message, 'err'); }
    finally { setBusy(false); }
  };
  // A .torrent file is turned into its magnet link here, then added the same way.
  const addFile = async () => {
    const res = await DocumentPicker.getDocumentAsync({ type: ['application/x-bittorrent', '*/*'], copyToCacheDirectory: true });
    const file = res.canceled ? null : res.assets?.[0];
    if (!file) return;
    setBusy(true);
    try {
      const bytes = new Uint8Array(await (await fetch(file.uri)).arrayBuffer());
      const t = torrentToMagnet(bytes);
      const res = await addMagnet(token, t.magnet, t.name);
      toast(`Sent “${t.name || file.name}” to TorBox`); onClose(); onAdded(res?.hash);
    } catch (e: any) {
      toast(/bencode|torrent|unexpected|invalid/i.test(e?.message ?? '') ? 'That file isn’t a valid .torrent' : e?.message ?? 'Could not add that file', 'err');
    } finally { setBusy(false); }
  };
  return (
    <Sheet visible={visible} onClose={onClose} title="Add a book">
      <View style={{ paddingHorizontal: 20, gap: 12, paddingTop: 4 }}>
        <TextInput value={text} onChangeText={setText} placeholder="magnet:?xt=urn:btih:…" placeholderTextColor={C.faint} accessibilityLabel="Magnet link"
          autoCapitalize="none" autoCorrect={false} multiline
          style={{ backgroundColor: C.bg, color: C.text, borderRadius: R.md, padding: 14, minHeight: 90, maxHeight: 160, textAlignVertical: 'top', borderWidth: 1, borderColor: C.line }} />
        <Button label="Add to TorBox" icon="cloud-download-outline" onPress={add} loading={busy} disabled={!text.trim()} />
        <Button kind="ghost" label="Choose a .torrent file" icon="document-attach-outline" onPress={addFile} disabled={busy} />
        <Text style={[T.small, { textAlign: 'center' }]}>Or find one in Discover → My sources and send it straight to TorBox.</Text>
      </View>
    </Sheet>
  );
}

/** A small, non-layout-affecting badge on a cover: progress while downloading, a tick when done. */
function DownloadMark({ rec }: { rec: DownloadBook }) {
  const complete = isComplete(rec);
  const failed = rec.status === 'failed';
  const label = complete ? 'Downloaded' : failed ? 'Failed' : rec.status === 'queued' ? 'Queued'
    : rec.status === 'paused' ? 'Paused' : `${Math.round(progressFraction(rec) * 100)}%`;
  const color = complete ? C.good : failed ? C.danger : C.text;
  const icon: IconName = complete ? 'arrow-down-circle' : failed ? 'alert-circle'
    : rec.status === 'queued' ? 'time-outline' : rec.status === 'paused' ? 'pause-outline' : 'arrow-down-circle';
  return (
    <View style={{ position: 'absolute', top: 8, left: 8, backgroundColor: 'rgba(0,0,0,0.65)', borderRadius: R.pill, paddingHorizontal: 8, paddingVertical: 4, flexDirection: 'row', gap: 4, alignItems: 'center' }}>
      <Ionicons name={icon} size={12} color={color} />
      <Text style={{ color, fontSize: 11, fontWeight: '700' }}>{label}</Text>
    </View>
  );
}

/** One book on the finished shelf: cover, title, author, finish date and a tappable star rating. */
function FinishedRow({ book, meta, finishedAt, onOpen, onMenu, onRate }: {
  book: TBTorrent;
  meta: BookMeta;
  finishedAt?: number;
  onOpen: () => void;
  onMenu: () => void;
  onRate: (star: number) => void;
}) {
  const title = meta.title ?? prettyName(book.name);
  const bits = [title];
  if (meta.author) bits.push(meta.author);
  if (finishedAt) bits.push(`finished ${formatFinishedDate(finishedAt)}`);
  if (meta.rating != null) bits.push(`rated ${meta.rating} out of 5`);
  return (
    <Tap haptic onPress={onOpen} onMenu={onMenu} accessibilityLabel={bits.join(', ')} accessibilityHint="Long press for options"
      hoverStyle={{ backgroundColor: C.hover, borderRadius: R.lg }}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 14, padding: 10, borderRadius: R.lg, backgroundColor: C.surface, marginBottom: 8 }}>
      <Cover title={book.name} uri={meta.cover} size={56} radius={R.sm} />
      <View style={{ flex: 1, gap: 3 }}>
        <Text numberOfLines={1} style={[T.title, { fontSize: 15 }]}>{title}</Text>
        {meta.author || finishedAt ? (
          <Text numberOfLines={1} style={T.small}>
            {[meta.author, finishedAt ? `Finished ${formatFinishedDate(finishedAt)}` : ''].filter(Boolean).join(' · ')}
          </Text>
        ) : null}
        {/* Each star is wider than its glyph, for the finger; pull the row left so the first lines up with the text. */}
        <View style={{ marginLeft: -8, marginTop: -4, marginBottom: -6 }}>
          <Stars rating={meta.rating} onRate={onRate} />
        </View>
      </View>
      <Tap onPress={(e) => { e.stopPropagation(); onMenu(); }} hitSlop={8} scaleTo={0.85} accessibilityLabel={`Options for ${title}`} style={{ padding: 6 }}>
        <Ionicons name="ellipsis-horizontal" size={18} color={C.sub} />
      </Tap>
    </Tap>
  );
}

/**
 * One "read elsewhere" book on the finished shelf: the same shape as a library row, plus a small
 * "Read elsewhere" label. Tapping the row does nothing (there is nothing to play); the stars and the
 * options button still work.
 */
function ElsewhereRow({ entry, onMenu, onRate }: {
  entry: ReadElsewhere;
  onMenu: () => void;
  onRate: (star: number) => void;
}) {
  const bits = [entry.title];
  if (entry.author) bits.push(entry.author);
  if (entry.finishedAt) bits.push(`finished ${formatFinishedDate(entry.finishedAt)}`);
  if (entry.rating != null) bits.push(`rated ${entry.rating} out of 5`);
  return (
    <Tap onMenu={onMenu} accessibilityLabel={bits.join(', ')} accessibilityHint="Long press for options"
      hoverStyle={{ backgroundColor: C.hover, borderRadius: R.lg }}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 14, padding: 10, borderRadius: R.lg, backgroundColor: C.surface, marginBottom: 8 }}>
      <Cover title={entry.title} uri={entry.cover} size={56} radius={R.sm} />
      <View style={{ flex: 1, gap: 3 }}>
        <Text numberOfLines={1} style={[T.title, { fontSize: 15 }]}>{entry.title}</Text>
        {/* The label shares the author line: beside the stars there is no room on a phone. */}
        <Text numberOfLines={1} style={T.small}>
          {[entry.author, entry.finishedAt ? `Read elsewhere ${formatFinishedDate(entry.finishedAt)}` : 'Read elsewhere'].filter(Boolean).join(' · ')}
        </Text>
        <View style={{ marginLeft: -8, marginTop: -4, marginBottom: -6 }}>
          <Stars rating={entry.rating} onRate={onRate} />
        </View>
      </View>
      <Tap onPress={(e) => { e.stopPropagation(); onMenu(); }} hitSlop={8} scaleTo={0.85} accessibilityLabel={`Options for ${entry.title}`} style={{ padding: 6 }}>
        <Ionicons name="ellipsis-horizontal" size={18} color={C.sub} />
      </Tap>
    </Tap>
  );
}

/** Five stars showing a 0.5–5 rating; a tap on one sets the rating through the shelf rule. */
function Stars({ rating, onRate }: { rating?: number; onRate: (star: number) => void }) {
  return (
    <View style={{ flexDirection: 'row' }}>
      {[1, 2, 3, 4, 5].map((n) => {
        const name: IconName = rating != null && rating >= n ? 'star' : rating != null && rating >= n - 0.5 ? 'star-half' : 'star-outline';
        return (
          <Tap key={n} onPress={(e) => { e.stopPropagation(); onRate(n); }} hitSlop={4} scaleTo={0.82}
            accessibilityLabel={`Rate ${n} star${n === 1 ? '' : 's'}`}
            style={{ width: 36, height: 40, alignItems: 'center', justifyContent: 'center' }}>
            <Ionicons name={name} size={20} color={name === 'star-outline' ? C.faint : C.accent} />
          </Tap>
        );
      })}
    </View>
  );
}
