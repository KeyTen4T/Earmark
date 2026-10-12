import React, { useEffect, useRef, useState } from 'react';
import { View, Text, ActivityIndicator, Keyboard, ScrollView, Linking, useWindowDimensions, Animated } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { createAudioPlayer } from 'expo-audio';
import type { AudioPlayer } from 'expo-audio';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { C, R, T } from '../theme';
import { Tap, Cover, Chip, ChipRow, Sheet, Empty, Button, toast, haptic, FadeIn, Pop, Skeleton, HeroHeader, StickyBar, useScrollY, FullCastChip, Input } from '../components/ui';
import { CatalogBook, GENRES, searchCatalog, lookupCatalog, topCharts, fullCastShelf, FULL_CAST } from '../catalog';
import { cleanFullCastTitle } from '../scrapers/cast';
import { loadBookInfo, type BookInfo, type Rating } from '../ratings';
import { formatAverage, formatRatings, ratingAccessibilityLabel, type Review } from '../ratings-match';
import { loadWishlist, saveWishlist, getAiKey } from '../storage';
import { onSyncApplied } from '../sync';
import { HistoryItem, recommend } from '../recommend';
import { usePlayer } from '../player/PlayerContext';
import { useLayout } from '../layout';

/**
 * Looks audiobooks up in a general catalogue, whether or not any source has them.
 * With an empty search box it's a place to browse: best-seller charts by genre, and the "Want to listen" list.
 */
const SAVED = 'saved'; // the shelf that isn't a genre
const HERO_COUNT = 10; // chart positions shown as the big cover row
const HERO_SIZE = 164;
const HERO_STEP = HERO_SIZE + 14; // one cover plus the gap after it
export function CatalogSearch({ modeToggle, bottomPad, onFindInSources, history, goSettings }: {
  modeToggle: React.ReactNode; bottomPad: number; onFindInSources: (query: string) => void;
  history: HistoryItem[]; goSettings: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const { wide, contentWidth } = useLayout();
  const listCols = wide && contentWidth >= 980 ? 2 : 1; // two columns of rows once there's room
  const player = usePlayer();
  const [q, setQ] = useState('');
  const [searched, setSearched] = useState('');
  const [results, setResults] = useState<CatalogBook[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [wishlist, setWishlist] = useState<CatalogBook[]>([]);
  const [detail, setDetail] = useState<CatalogBook | null>(null);
  const [info, setInfo] = useState<BookInfo | null>(null);
  const [sampling, setSampling] = useState(false);
  const sample = useRef<AudioPlayer | null>(null);
  const run = useRef(0);
  const { y, onScroll } = useScrollY();
  const heroX = useRef(new Animated.Value(0)).current;
  const [shelf, setShelf] = useState(''); // a genre id ('' = overall chart) or SAVED
  const [chart, setChart] = useState<CatalogBook[]>([]);
  const [chartBusy, setChartBusy] = useState(false);
  const [chartError, setChartError] = useState('');

  useEffect(() => { loadWishlist().then(setWishlist); }, []);
  // The Want to listen list can change from a sync on another device.
  useEffect(() => onSyncApplied(() => { loadWishlist().then(setWishlist); }), []);

  // Ratings and reviews for the open book. Nothing is reserved and no spinner shows: each piece appears
  // only once its lookup found something, and a reply that lands after the user moved to another book
  // is ignored.
  useEffect(() => {
    if (!detail) { setInfo(null); return; }
    let live = true;
    setInfo(null);
    loadBookInfo(detail).then((r) => { if (live) setInfo(r); }).catch(() => {});
    return () => { live = false; };
  }, [detail?.id]);

  useEffect(() => {
    if (shelf === SAVED) return;
    let live = true;
    setChart([]); setChartError(''); setChartBusy(true); heroX.setValue(0);
    (shelf === FULL_CAST ? fullCastShelf() : topCharts(shelf))
      .then((b) => { if (live) setChart(b); })
      .catch((e) => { if (live) setChartError(e.message ?? (shelf === FULL_CAST ? 'Couldn’t load the full-cast shelf' : 'Couldn’t load the charts')); })
      .finally(() => { if (live) setChartBusy(false); });
    return () => { live = false; };
  }, [shelf]);

  // ---- Surprise me: one pick from the current chart, personal when an AI key is set, random otherwise ----
  const [surprising, setSurprising] = useState(false);
  const [pick, setPick] = useState<{ id: string; reason: string; personal: boolean } | null>(null);
  const suggested = useRef<string[]>([]);
  const surprise = async () => {
    if (surprising) return;
    setSurprising(true);
    try {
      const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      const pool0 = shelf === SAVED ? await topCharts('') : chart.length ? chart : shelf === FULL_CAST ? await fullCastShelf() : await topCharts(shelf);
      // Leave out what they already have, already saved, or were just shown.
      const have = history.map((h) => norm(h.title)).filter(Boolean);
      const fresh = pool0.filter((b) => !wishlist.some((w) => w.id === b.id) && !have.some((t) => norm(b.title).startsWith(t) || t.startsWith(norm(b.title))));
      let pool = fresh.filter((b) => !suggested.current.includes(b.id));
      if (!pool.length) { suggested.current = []; pool = fresh.length ? fresh : pool0; }
      if (!pool.length) throw new Error('The charts haven’t loaded yet');
      pool = [...pool].sort(() => Math.random() - 0.5);
      const key = await getAiKey();
      let chosen = { id: pool[0].id, reason: '', personal: false };
      if (key) {
        try {
          const full: HistoryItem[] = [...history, ...wishlist.map((w): HistoryItem => ({ title: w.title, author: w.author, status: 'wants to listen' }))];
          const r = await recommend(key, full, pool.map((b) => ({ id: b.id, title: b.title, author: b.author, genre: b.genre })), suggested.current.slice(-10));
          chosen = { ...r, personal: true };
        } catch (e: any) {
          toast(`${e.message ?? 'The AI pick failed'} Here’s a random one instead.`, 'err');
        }
      }
      suggested.current.push(chosen.id);
      haptic('bump');
      setPick(chosen);
      openDetail(pool.find((b) => b.id === chosen.id)!);
    } catch (e: any) {
      toast(e.message ?? 'Couldn’t pick a book', 'err');
    } finally {
      setSurprising(false);
    }
  };

  // Chart entries arrive without a description; fetch it when one is opened.
  const openDetail = (b: CatalogBook) => {
    setDetail(b);
    if (b.description) return;
    lookupCatalog(b.id).then((full) => {
      if (full?.description) setDetail((d) => (d?.id === b.id ? { ...d, description: full.description } : d));
    }).catch(() => {});
  };

  const search = async () => {
    const query = q.trim();
    if (!query) return;
    Keyboard.dismiss();
    const my = ++run.current;
    setBusy(true); setError(''); setSearched(query); setResults([]);
    try {
      const r = await searchCatalog(query);
      if (my === run.current) setResults(r);
    } catch (e: any) {
      if (my === run.current) setError(e.message ?? 'Search failed');
    } finally {
      if (my === run.current) setBusy(false);
    }
  };

  const clear = () => { run.current++; setQ(''); setSearched(''); setResults([]); setError(''); setBusy(false); };

  const wanted = (b: CatalogBook) => wishlist.some((w) => w.id === b.id);
  const toggleWanted = (b: CatalogBook) => {
    const next = wanted(b) ? wishlist.filter((w) => w.id !== b.id) : [b, ...wishlist];
    setWishlist(next);
    saveWishlist(next);
    haptic('bump');
    toast(wanted(b) ? 'Removed from Want to listen' : 'Saved to Want to listen');
  };

  const stopSample = () => {
    try { sample.current?.pause(); sample.current?.remove(); } catch { /* already gone */ }
    sample.current = null;
    setSampling(false);
  };
  const toggleSample = (b: CatalogBook) => {
    if (sampling) return stopSample();
    if (!b.previewUrl) return;
    try {
      if (player.playing) player.toggle(); // don't talk over the book that's playing
      const p = createAudioPlayer({ uri: b.previewUrl });
      p.addListener('playbackStatusUpdate', (s: any) => { if (s?.didJustFinish) stopSample(); });
      p.play();
      sample.current = p;
      setSampling(true);
    } catch (e: any) {
      toast(e.message ?? 'Could not play the sample', 'err');
    }
  };
  const closeDetail = () => { stopSample(); setDetail(null); setPick(null); };
  useEffect(() => stopSample, []);

  // The top ten: a snapping, swipeable row on a phone; a plain grid on desktop, where there's no swiping.
  const HeroRow: React.ComponentType<any> = wide ? View : Animated.ScrollView;
  const heroRowProps = wide
    ? { style: { paddingHorizontal: 20, gap: 18, flexDirection: 'row', flexWrap: 'wrap' } }
    : {
      horizontal: true, showsHorizontalScrollIndicator: false, contentContainerStyle: { paddingHorizontal: 20, gap: 14 },
      snapToInterval: HERO_STEP, decelerationRate: 'fast', scrollEventThrottle: 16,
      onScroll: Animated.event([{ nativeEvent: { contentOffset: { x: heroX } } }], { useNativeDriver: true }),
    };

  const browsing = !searched;
  const showingWishlist = browsing && shelf === SAVED;
  const showingFullCast = browsing && shelf === FULL_CAST;
  const showingChart = browsing && !showingWishlist && !showingFullCast;
  const genre = GENRES.find((g) => g.id === shelf);
  // The chart's first ten are the big cover row in the header; the list carries on from 11. The full
  // cast shelf is not a chart, so it is shown whole, without ranks.
  const data = showingChart ? chart.slice(HERO_COUNT) : showingFullCast ? chart : showingWishlist ? wishlist : results;

  const header = (
    <View style={{ paddingTop: insets.top + (wide ? 28 : 12) }}>
      <View style={{ paddingHorizontal: 20, maxWidth: 720 }}>
        <HeroHeader y={y} label="Find something new" title="Discover" style={{ marginBottom: 14 }} />
        {modeToggle}
        <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: C.surface, borderRadius: R.lg, borderWidth: 1, borderColor: C.line, paddingHorizontal: 14, height: 54 }}>
          <Ionicons name="search" size={20} color={C.faint} />
          <Input value={q} onChangeText={setQ} onSubmitEditing={search} returnKeyType="search" accessibilityLabel="Search audiobooks"
            placeholder="Any audiobook, author or series…" placeholderTextColor={C.faint}
            style={{ flex: 1, color: C.text, fontSize: 16, marginLeft: 10 }} />
          {busy ? <ActivityIndicator color={C.accent} /> : q || searched ? (
            <Tap onPress={clear} hitSlop={10} accessibilityLabel="Clear search"><Ionicons name="close-circle" size={20} color={C.faint} /></Tap>
          ) : null}
        </View>
      </View>
      {browsing ? (
        <ChipRow style={{ paddingTop: 14 }}>
          {GENRES.slice(0, 1).map((g) => <Chip key={g.id} label={g.name} active={shelf === g.id} onPress={() => setShelf(g.id)} />)}
          <Chip label={wishlist.length ? `Want to listen · ${wishlist.length}` : 'Want to listen'} active={shelf === SAVED} onPress={() => setShelf(SAVED)} />
          <Chip label="Full cast" active={shelf === FULL_CAST} onPress={() => setShelf(FULL_CAST)} />
          {GENRES.slice(1).map((g) => <Chip key={g.id} label={g.name} active={shelf === g.id} onPress={() => setShelf(g.id)} />)}
        </ChipRow>
      ) : null}
      {browsing ? (
        <View style={{ paddingHorizontal: 20, marginTop: 14, maxWidth: 360 }}>
          <Button icon="dice-outline" label={shelf === FULL_CAST ? 'Surprise me · Full cast' : shelf && shelf !== SAVED ? `Surprise me · ${genre?.name}` : 'Surprise me'} onPress={surprise} loading={surprising} />
        </View>
      ) : null}
      {showingChart && chart.length ? (
        <>
          <Text style={[T.label, { paddingHorizontal: 20, marginTop: 20, marginBottom: 10 }]}>
            {shelf ? `Top 10 in ${genre?.name}` : 'Top 10 right now'}
          </Text>
          <HeroRow key={shelf} {...heroRowProps}>
            {chart.slice(0, HERO_COUNT).map((b, i) => {
              // The cover at the front of the row is full size; its neighbours sit back a little.
              const at = [(i - 1) * HERO_STEP, i * HERO_STEP, (i + 1) * HERO_STEP];
              // On desktop they're a grid with nothing to swipe, so every cover is full size.
              const scale = wide ? 1 : heroX.interpolate({ inputRange: at, outputRange: [0.9, 1, 0.9], extrapolate: 'clamp' });
              const dim = wide ? 1 : heroX.interpolate({ inputRange: at, outputRange: [0.7, 1, 0.7], extrapolate: 'clamp' });
              return (
              <FadeIn key={b.id} index={i} y={24}>
              <Animated.View style={{ width: HERO_SIZE, opacity: dim, transform: [{ scale }] }}>
              <Tap onPress={() => openDetail(b)} scaleTo={0.97} hoverStyle={{ backgroundColor: C.hover, borderRadius: R.md }}>
                <View>
                  <Cover title={b.title} uri={b.cover} size={HERO_SIZE} radius={R.md} />
                  <View style={{ position: 'absolute', left: 8, bottom: 8, minWidth: 30, height: 30, paddingHorizontal: 8, borderRadius: 15, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center' }}>
                    <Text style={{ color: C.accentInk, fontWeight: '800', fontSize: 14 }}>{i + 1}</Text>
                  </View>
                  {wanted(b) ? <Ionicons name="bookmark" size={18} color={C.accent} style={{ position: 'absolute', right: 8, top: 8 }} /> : null}
                </View>
                <Text numberOfLines={2} style={[T.title, { fontSize: 13, marginTop: 8 }]}>{b.title}</Text>
                {b.author ? <Text numberOfLines={1} style={T.small}>{b.author}</Text> : null}
              </Tap>
              </Animated.View>
              </FadeIn>
              );
            })}
          </HeroRow>
        </>
      ) : null}
      <Text style={[T.label, { paddingHorizontal: 20, marginTop: 20, marginBottom: 6 }]}>
        {showingChart ? (chartBusy ? 'Loading the charts…' : chart.length > HERO_COUNT ? `The rest of the top ${chart.length}` : '')
          : showingFullCast ? (chartBusy ? 'Loading full cast…' : chart.length ? `Full cast & dramatised · ${chart.length}` : '')
          : showingWishlist ? (wishlist.length ? `Want to listen · ${wishlist.length}` : '') : busy ? 'Searching…' : `${results.length} in the catalogue`}
      </Text>
      {showingChart && chartBusy ? (
        <View style={{ paddingHorizontal: 20, gap: 14 }}>
          <View style={{ flexDirection: 'row', gap: 14 }}>
            {[0, 1, 2].map((i) => <Skeleton key={i} width={HERO_SIZE} height={HERO_SIZE} />)}
          </View>
          {[0, 1, 2].map((i) => (
            <View key={i} style={{ flexDirection: 'row', gap: 14, alignItems: 'center', marginTop: 6 }}>
              <Skeleton width={64} height={64} radius={10} />
              <View style={{ flex: 1, gap: 8 }}><Skeleton width="80%" height={14} radius={7} /><Skeleton width="45%" height={12} radius={6} /></View>
            </View>
          ))}
        </View>
      ) : null}
      {showingFullCast && chartBusy ? (
        <View style={{ paddingHorizontal: 20, gap: 14 }}>
          {[0, 1, 2, 3].map((i) => (
            <View key={i} style={{ flexDirection: 'row', gap: 14, alignItems: 'center' }}>
              <Skeleton width={64} height={64} radius={10} />
              <View style={{ flex: 1, gap: 8 }}><Skeleton width="80%" height={14} radius={7} /><Skeleton width="45%" height={12} radius={6} /></View>
            </View>
          ))}
        </View>
      ) : null}
      {(showingChart || showingFullCast) && chartError ? <Text style={{ color: C.danger, paddingHorizontal: 20, marginBottom: 8 }}>{chartError}</Text> : null}
      {error ? <Text style={{ color: C.danger, paddingHorizontal: 20, marginBottom: 8 }}>{error}</Text> : null}
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Animated.FlatList onScroll={onScroll} scrollEventThrottle={16}
        key={`cols-${listCols}`} numColumns={listCols}
        data={data}
        keyExtractor={(b) => b.id}
        ListHeaderComponent={header}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{ paddingBottom: bottomPad + 24 }}
        ListEmptyComponent={busy || error || showingChart || (showingFullCast && (chartBusy || !!chartError)) ? null
          : showingFullCast ? (
            <Empty icon="people-outline" title="No full-cast books"
              body="The catalogue returned no dramatised or full-cast audiobooks just now." />
          ) : showingWishlist ? (
            <Empty icon="bookmark-outline" title="Nothing saved yet"
              body="Tap the bookmark on any book in the charts or in a search and it’ll be kept here." />
          ) : (
            <Empty icon="sad-outline" title="No results" body={`Nothing matched “${searched}”. Try just the title or the author.`} />
          )}
        renderItem={({ item: b, index }) => (
          <FadeIn index={index} style={listCols > 1 ? { flex: 1 } : undefined}>
          <Tap onPress={() => openDetail(b)} scaleTo={0.98} hoverStyle={{ backgroundColor: C.hover }} style={{ flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 20, paddingVertical: 10 }}>
            {showingChart ? <Text style={{ width: 26, textAlign: 'center', color: C.faint, fontWeight: '800', fontSize: 15 }}>{index + HERO_COUNT + 1}</Text> : null}
            <Cover title={b.title} uri={b.cover} size={64} radius={10} />
            <View style={{ flex: 1, gap: 3 }}>
              <Text numberOfLines={2} style={[T.title, { fontSize: 15 }]}>{b.title}</Text>
              {b.author ? <Text numberOfLines={1} style={T.body}>{b.author}</Text> : null}
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                {showingFullCast ? <FullCastChip /> : null}
                <Text numberOfLines={1} style={[T.small, { flex: 1 }]}>{[b.genre, b.year].filter(Boolean).join('  ·  ')}</Text>
              </View>
            </View>
            <Tap onPress={() => toggleWanted(b)} hitSlop={8} scaleTo={0.85} accessibilityLabel={wanted(b) ? 'Remove from Want to listen' : 'Save to Want to listen'} style={{
              width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center',
              backgroundColor: wanted(b) ? 'rgba(255,181,71,0.15)' : C.elevated, borderWidth: 1, borderColor: wanted(b) ? C.accent : C.line,
            }}>
              <Pop on={wanted(b)} from={0.5}>
                <Ionicons name={wanted(b) ? 'bookmark' : 'bookmark-outline'} size={18} color={wanted(b) ? C.accent : C.text} />
              </Pop>
            </Tap>
          </Tap>
          </FadeIn>
        )}
      />
      <StickyBar y={y} title={searched ? `“${searched}”` : showingFullCast ? 'Full cast' : showingWishlist ? 'Want to listen' : genre?.id ? genre.name : 'Discover'} />

      <Sheet visible={!!detail} onClose={closeDetail}>
        {detail && (
          <ScrollView style={{ maxHeight: height * 0.72 }} contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 4, paddingBottom: 8, gap: 14 }}>
            <View style={{ flexDirection: 'row', gap: 16 }}>
              <Cover title={detail.title} uri={detail.cover} size={120} radius={R.md} />
              <View style={{ flex: 1, gap: 4 }}>
                <Text style={T.h2} numberOfLines={4}>{detail.title}</Text>
                {detail.author ? <Text style={T.body}>by {detail.author}</Text> : null}
                <Text style={T.small}>{[detail.genre, detail.year, detail.price].filter(Boolean).join('  ·  ')}</Text>
              </View>
            </View>
            {info?.rating ? <RatingRow rating={info.rating} /> : null}
            {pick?.id === detail.id ? (
              <FadeIn key={pick.id} y={10} style={{ backgroundColor: 'rgba(255,181,71,0.10)', borderColor: C.accent, borderWidth: 1, borderRadius: R.md, padding: 12, gap: 8 }}>
                <Text style={[T.label, { color: C.accent }]}>{pick.personal ? 'Picked for you' : 'Random pick'}</Text>
                {pick.personal && pick.reason ? <Text style={[T.body, { lineHeight: 21 }]}>{pick.reason}</Text> : null}
                {!pick.personal ? (
                  <Text style={T.small}>
                    Want picks based on what you’ve listened to?{' '}
                    <Text style={{ color: C.accent, fontWeight: '700' }} onPress={() => { closeDetail(); goSettings(); }}>Add an AI key in Settings.</Text>
                  </Text>
                ) : null}
                <Button kind="ghost" icon="dice-outline" label="Try another" onPress={surprise} loading={surprising} />
              </FadeIn>
            ) : null}
            <Button kind="primary" icon="search" label="Search my sources"
              onPress={() => { const b = detail; closeDetail(); onFindInSources(showingFullCast ? cleanFullCastTitle(b.title) : b.title); }} />
            <View style={{ flexDirection: 'row', gap: 8 }}>
              {detail.previewUrl ? (
                <Button kind="ghost" icon={sampling ? 'stop' : 'play'} label={sampling ? 'Stop sample' : 'Play sample'} onPress={() => toggleSample(detail)} style={{ flex: 1 }} />
              ) : null}
              <Button kind="ghost" icon={wanted(detail) ? 'bookmark' : 'bookmark-outline'}
                label={wanted(detail) ? 'Saved' : 'Want to listen'} onPress={() => toggleWanted(detail)} style={{ flex: 1 }} />
            </View>
            {detail.description ? <Text style={[T.body, { lineHeight: 21 }]}>{detail.description}</Text> : null}
            {info?.reviews?.length ? (
              <>
                <Text style={T.label}>Reviews</Text>
                <View style={{ gap: 14 }}>
                  {info.reviews.map((review, i) => <ReviewBlock key={i} review={review} />)}
                </View>
                {info.slug ? (
                  <Button kind="ghost" icon="open-outline" label="More on Hardcover"
                    onPress={() => Linking.openURL(`https://hardcover.app/books/${info.slug}`)} />
                ) : null}
              </>
            ) : null}
            {detail.url ? <Button kind="ghost" icon="open-outline" label="Apple Books" onPress={() => Linking.openURL(detail.url!)} /> : null}
          </ScrollView>
        )}
      </Sheet>
    </View>
  );
}

/** A book's average and count, quietly credited to the service it came from. */
function RatingRow({ rating }: { rating: Rating }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
      <View accessible accessibilityLabel={ratingAccessibilityLabel(rating.average, rating.count, rating.source)}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Ionicons name="star" size={13} color={C.accent} />
        <Text style={{ color: C.text, fontSize: 13, fontWeight: '700' }}>{formatAverage(rating.average)}</Text>
        <Text style={{ color: C.sub, fontSize: 12 }}>{formatRatings(rating.count)}</Text>
      </View>
      {rating.url ? (
        <Tap onPress={() => Linking.openURL(rating.url!)} hitSlop={6} accessibilityRole="link" accessibilityLabel={`Open on ${rating.source}`}>
          <Text style={{ color: C.faint, fontSize: 11, fontWeight: '600', textDecorationLine: 'underline' }}>{rating.source}</Text>
        </Tap>
      ) : (
        <Text style={{ color: C.faint, fontSize: 11, fontWeight: '600' }}>{rating.source}</Text>
      )}
    </View>
  );
}

/** One reader's review: who, their stars, and the body clamped to six lines until asked for more. */
function ReviewBlock({ review }: { review: Review }) {
  const [open, setOpen] = useState(false);
  const long = review.text.length > 260;
  return (
    <View style={{ gap: 4 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <Text style={{ color: C.text, fontSize: 13, fontWeight: '700' }} numberOfLines={1}>{review.username}</Text>
        {review.rating != null ? <Text style={{ color: C.accent, fontSize: 12, fontWeight: '700' }}>★ {formatAverage(review.rating)}</Text> : null}
      </View>
      <Text style={[T.body, { lineHeight: 20 }]} numberOfLines={open || !long ? undefined : 6}>{review.text}</Text>
      {long ? (
        <Tap onPress={() => setOpen((v) => !v)} hitSlop={6} accessibilityLabel={open ? 'Show less of this review' : 'Show the rest of this review'}>
          <Text style={{ color: C.accent, fontSize: 12, fontWeight: '700' }}>{open ? 'Less' : 'More'}</Text>
        </Tap>
      ) : null}
    </View>
  );
}
