import React, { useEffect, useRef, useState } from 'react';
import { View, Text, TextInput, ActivityIndicator, Keyboard, ScrollView, Alert, Animated, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { C, R, T } from '../theme';
import { Tap, Cover, Chip, ChipRow, Sheet, Empty, Button, toast, haptic, FadeIn, Pop, Skeleton, HeroHeader, StickyBar, useScrollY } from '../components/ui';
import { ScraperDef, SearchResult, runSearch, resolveMagnet, dedupeResults, fetchDetail } from '../scrapers/engine';
import { isFullCast } from '../scrapers/cast';
import { hashFromMagnet } from '../scrapers/bencode';
import { addMagnet, checkCached, torrentHealth } from '../torbox';
import { saveMeta } from '../storage';
import { CatalogSearch } from './CatalogSearch';
import { useLayout } from '../layout';
import type { HistoryItem } from '../recommend';

type AddState = 'adding' | 'added';

type Props = { token: string; history: HistoryItem[]; scrapers: ScraperDef[]; bottomPad: number; onAdded: (hash?: string) => void; goSources: () => void };
type Mode = 'catalog' | 'sources';

/** Discover has two searches: the general audiobook catalogue, and the user's own sources (which can add to TorBox). */
export function DiscoverScreen(props: Props) {
  const [mode, setMode] = useState<Mode>('catalog');
  const [seed, setSeed] = useState<{ q: string; n: number } | null>(null);
  const modeToggle = (
    <View style={{ flexDirection: 'row', backgroundColor: C.surface, borderRadius: R.pill, borderWidth: 1, borderColor: C.line, padding: 4, marginBottom: 14 }}>
      {([['catalog', 'All audiobooks', 'library-outline'], ['sources', 'My sources', 'extension-puzzle-outline']] as [Mode, string, any][]).map(([k, label, icon]) => (
        <Tap key={k} onPress={() => setMode(k)} haptic scaleTo={0.97} hitSlop={3} accessibilityLabel={label} accessibilityState={{ selected: mode === k }} style={{ flex: 1, minHeight: 38, borderRadius: R.pill, flexDirection: 'row', gap: 6, alignItems: 'center', justifyContent: 'center', backgroundColor: mode === k ? C.accent : 'transparent' }}>
          <Ionicons name={icon} size={15} color={mode === k ? C.accentInk : C.sub} />
          <Text style={{ color: mode === k ? C.accentInk : C.sub, fontWeight: '700', fontSize: 13 }}>{label}</Text>
        </Tap>
      ))}
    </View>
  );
  // Both stay mounted so switching back and forth keeps each one's results.
  return (
    <View style={{ flex: 1 }}>
      <View style={{ flex: 1, display: mode === 'catalog' ? 'flex' : 'none' }}>
        <CatalogSearch modeToggle={modeToggle} bottomPad={props.bottomPad} history={props.history} goSettings={props.goSources}
          onFindInSources={(q) => { setSeed({ q, n: Date.now() }); setMode('sources'); }} />
      </View>
      <View style={{ flex: 1, display: mode === 'sources' ? 'flex' : 'none' }}>
        <SourceSearch {...props} modeToggle={modeToggle} seed={seed} />
      </View>
    </View>
  );
}

function SourceSearch({ token, scrapers, bottomPad, onAdded, goSources, modeToggle, seed }: Props & {
  modeToggle: React.ReactNode; seed: { q: string; n: number } | null; // seed: a search handed over from the catalogue
}) {
  const insets = useSafeAreaInsets();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [pending, setPending] = useState<string[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [source, setSource] = useState<string | null>(null);
  const [cached, setCached] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState<Record<string, AddState>>({});
  const [detailId, setDetailId] = useState<string | null>(null);
  const [searched, setSearched] = useState('');
  const run = useRef(0);
  const fetchedDetails = useRef(new Set<string>());
  const { y, onScroll } = useScrollY();
  const { wide, contentWidth } = useLayout();
  const listCols = wide && contentWidth >= 980 ? 2 : 1;
  // The sheet reads the live row, so filling in the narrator updates the sheet and the list at once.
  const detail = detailId ? results.find((r) => r.id === detailId) ?? null : null;

  const search = async (text = q) => {
    const query = text.trim();
    if (!query || !scrapers.length) return;
    Keyboard.dismiss();
    const my = ++run.current;
    setResults([]); setErrors({}); setSource(null); setSearched(query);
    fetchedDetails.current.clear();
    setPending(scrapers.map((s) => s.id));
    await Promise.all(scrapers.map(async (s) => {
      try {
        const r = await runSearch(s, query);
        if (my !== run.current) return;
        setResults((prev) => dedupeResults([...prev, ...r]));
        const hashes = r.map((x) => x.infoHash).filter(Boolean) as string[];
        if (hashes.length) {
          const c = await checkCached(token, hashes);
          if (my === run.current && c.size) setCached((prev) => new Set([...prev, ...c]));
        }
      } catch (e: any) {
        if (my === run.current) setErrors((prev) => ({ ...prev, [s.id]: e.message ?? 'failed' }));
      } finally {
        if (my === run.current) setPending((prev) => prev.filter((id) => id !== s.id));
      }
    }));
  };

  useEffect(() => { if (seed) { setQ(seed.q); search(seed.q); } }, [seed?.n]);

  // A tapped result with a detail page fills in its narrator once. Only the tapped row is touched, so a
  // late answer can't overwrite the sheet when it has moved on to another result.
  useEffect(() => {
    if (!detail || detail.narrator || fetchedDetails.current.has(detail.id)) return;
    const def = scrapers.find((s) => s.id === detail.scraperId);
    if (!def?.detail?.fields.narrator) return;
    const id = detail.id;
    const my = run.current;
    fetchedDetails.current.add(id);
    fetchDetail(def, detail)
      .then((d) => {
        if (my !== run.current) return; // a new search: drop the late answer
        setResults((prev) => prev.map((r) => (r.id === id ? {
          ...r, narrator: d.narrator ?? r.narrator, magnet: d.magnet ?? r.magnet,
          infoHash: d.infoHash ?? r.infoHash, torrentUrl: d.torrentUrl ?? r.torrentUrl,
        } : r)));
      })
      .catch(() => {}); // an unreachable source just leaves the row as it was
  }, [detailId]);

  const add = async (r: SearchResult) => {
    if (adding[r.id]) return;
    setAdding((a) => ({ ...a, [r.id]: 'adding' }));
    try {
      const def = scrapers.find((s) => s.id === r.scraperId);
      const magnet = await resolveMagnet(def, r);
      // TorBox can only deliver a book it already has cached or can download from seeders, so check first.
      const known = hashFromMagnet(magnet);
      const isCached = !!known && (cached.has(known) || (await checkCached(token, [known])).has(known));
      let status = 'ready now';
      if (!isCached) {
        toast('Not cached on TorBox. Checking that it’s being seeded, which can take half a minute…');
        let health: { seeds: number; peers: number } | null = null;
        let failed = false;
        try { health = await torrentHealth(token, magnet); } catch { failed = true; }
        if (failed || !health?.seeds) {
          // A failed check is unknown, not empty: TorBox simply didn't answer.
          const noSeeders = !failed;
          const title = noSeeders ? 'Nobody seems to be seeding this' : 'Couldn’t check for seeders';
          const why = noSeeders
            ? 'It isn’t cached on TorBox and TorBox couldn’t find anyone sharing it, so it would probably never download. Another result may work better.'
            : 'TorBox didn’t answer, so it’s unknown whether this will download. It may still work, but another result may be safer.';
          // Alert does nothing on the desktop build, so ask with the window's own confirm box there.
          const go = Platform.OS === 'web' ? !!(globalThis as any).confirm?.(`${title}.\n\n${why}\n\nAdd anyway?`) : await new Promise<boolean>((done) => Alert.alert(
            title,
            why,
            [{ text: 'Cancel', style: 'cancel', onPress: () => done(false) }, { text: 'Add anyway', onPress: () => done(true) }],
            { cancelable: true, onDismiss: () => done(false) }));
          if (!go) { setAdding((a) => { const n = { ...a }; delete n[r.id]; return n; }); return; }
          status = noSeeders ? 'no seeders found' : 'seeders not checked';
        } else status = `downloading from ${health.seeds} seeder${health.seeds === 1 ? '' : 's'}`;
      }
      const res = await addMagnet(token, magnet, r.title);
      const hash = res?.hash ?? known;
      if (hash) await saveMeta(hash, { title: r.title, author: r.author, narrator: r.narrator, cover: r.cover });
      setAdding((a) => ({ ...a, [r.id]: 'added' }));
      haptic('bump');
      if (res?.queued_id && !res.torrent_id) toast(`“${r.title}” is queued on TorBox: your download slots are full. It joins the library when it starts.`);
      else toast(`Added “${r.title}” · ${status}`);
      onAdded(hash);
    } catch (e: any) {
      setAdding((a) => { const n = { ...a }; delete n[r.id]; return n; });
      toast(e.message ?? 'Could not add', 'err');
    }
  };

  const shown = source ? results.filter((r) => r.scraperId === source) : results;
  const counts = results.reduce<Record<string, number>>((a, r) => ((a[r.scraperId] = (a[r.scraperId] ?? 0) + 1), a), {});
  const busy = pending.length > 0;

  const header = (
    <View style={{ paddingTop: insets.top + (wide ? 28 : 12) }}>
      <View style={{ paddingHorizontal: 20, maxWidth: 720 }}>
        <HeroHeader y={y} label="Find something new" title="Discover" style={{ marginBottom: 14 }} />
        {modeToggle}
        <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: C.surface, borderRadius: R.lg, borderWidth: 1, borderColor: C.line, paddingHorizontal: 14, height: 54 }}>
          <Ionicons name="search" size={20} color={C.faint} />
          <TextInput value={q} onChangeText={setQ} onSubmitEditing={() => search()} returnKeyType="search" accessibilityLabel="Search sources"
            placeholder="Title, author, narrator…" placeholderTextColor={C.faint}
            style={{ flex: 1, color: C.text, fontSize: 16, marginLeft: 10 }} />
          {busy ? <ActivityIndicator color={C.accent} /> : q ? (
            <Tap onPress={() => setQ('')} hitSlop={10} accessibilityLabel="Clear search"><Ionicons name="close-circle" size={20} color={C.faint} /></Tap>
          ) : null}
        </View>
      </View>

      {searched ? (
        <ChipRow style={{ paddingVertical: 16 }}>
          <Chip label={`All ${results.length}`} active={!source} onPress={() => setSource(null)} />
          {scrapers.map((s) => (
            <Chip key={s.id} active={source === s.id} onPress={() => setSource(s.id)}
              label={`${s.name} ${pending.includes(s.id) ? '…' : errors[s.id] ? '!' : counts[s.id] ?? 0}`} />
          ))}
        </ChipRow>
      ) : null}

      {Object.entries(errors).filter(([id]) => !source || id === source).map(([id, msg]) => (
        <View key={id} style={{ marginHorizontal: 20, marginBottom: 10, padding: 12, borderRadius: R.md, backgroundColor: 'rgba(255,107,107,0.1)', flexDirection: 'row', gap: 8 }}>
          <Ionicons name="warning-outline" size={16} color={C.danger} />
          <Text style={{ color: C.sub, flex: 1, fontSize: 13 }}>
            <Text style={{ color: C.text, fontWeight: '700' }}>{scrapers.find((s) => s.id === id)?.name}: </Text>{msg}
          </Text>
        </View>
      ))}
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Animated.FlatList onScroll={onScroll} scrollEventThrottle={16}
        key={`cols-${listCols}`} numColumns={listCols}
        data={shown}
        keyExtractor={(r) => r.id}
        ListHeaderComponent={header}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{ paddingBottom: bottomPad + 24 }}
        ListEmptyComponent={
          !scrapers.length ? (
            <Empty icon="extension-puzzle-outline" title="No sources enabled" body="Discover searches using scraper sources. Turn one on or import a .json scraper."
              action={<Button label="Manage sources" icon="extension-puzzle" onPress={goSources} />} />
          ) : busy ? (
            <View style={{ paddingHorizontal: 20, gap: 20, paddingTop: 10 }}>
              {[0, 1, 2, 3, 4].map((i) => (
                <View key={i} style={{ flexDirection: 'row', gap: 14, alignItems: 'center' }}>
                  <Skeleton width={64} height={64} radius={10} />
                  <View style={{ flex: 1, gap: 8 }}><Skeleton width="85%" height={14} radius={7} /><Skeleton width="50%" height={12} radius={6} /></View>
                </View>
              ))}
            </View>
          ) : searched ? (
            <Empty icon="sad-outline" title="No results" body={`Nothing matched “${searched}”. Try fewer words or another source.`} />
          ) : (
            <Empty icon="sparkles-outline" title="Search your sources" body={`Searching ${scrapers.map((s) => s.name).join(', ')}. Tap a result for details, or + to send it to TorBox.`} />
          )
        }
        renderItem={({ item: r, index }) => (
          <FadeIn index={index} style={listCols > 1 ? { flex: 1 } : undefined}>
            <ResultRow r={r} cached={!!r.infoHash && cached.has(r.infoHash)} state={adding[r.id]} onAdd={() => add(r)} onPress={() => setDetailId(r.id)} />
          </FadeIn>
        )}
      />
      <StickyBar y={y} title={searched ? `“${searched}”` : 'Discover'} />

      <Sheet visible={!!detail} onClose={() => setDetailId(null)}>
        {detail && (
          <View style={{ paddingHorizontal: 20, paddingTop: 4, gap: 16 }}>
            <View style={{ flexDirection: 'row', gap: 16 }}>
              <Cover title={detail.title} uri={detail.cover} size={120} radius={R.md} />
              <View style={{ flex: 1, gap: 4 }}>
                <Text style={T.h2} numberOfLines={4}>{detail.title}</Text>
                {detail.author ? <Text style={T.body}>by {detail.author}</Text> : null}
                {detail.narrator ? <Text style={T.small}>Narrated by {detail.narrator}</Text> : null}
              </View>
            </View>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              <Meta icon="pricetag-outline" text={`${detail.icon ?? ''} ${detail.scraperName}`.trim()} />
              {detail.size ? <Meta icon="server-outline" text={detail.size} /> : null}
              {detail.duration ? <Meta icon="time-outline" text={detail.duration} /> : null}
              {seedText(detail, 'seeders') ? <Meta icon="people-outline" text={seedText(detail, 'seeders')} /> : null}
              {isFullCast(detail) ? <Meta icon="people-circle-outline" text="Full cast" /> : null}
              {detail.infoHash && cached.has(detail.infoHash) ? <Meta icon="flash" text="Cached on TorBox" accent /> : null}
            </View>
            <Button label={adding[detail.id] === 'added' ? 'Added to library' : 'Send to TorBox'}
              icon={adding[detail.id] === 'added' ? 'checkmark' : 'cloud-download-outline'}
              loading={adding[detail.id] === 'adding'} disabled={adding[detail.id] === 'added'} onPress={() => add(detail)} />
          </View>
        )}
      </Sheet>
    </View>
  );
}

// "0 seeds" only means something for a real swarm; archive.org-style results have no count at all.
function seedText(r: SearchResult, word: string) {
  if (!r.seeders || (Number(r.seeders) === 0 && !r.magnet && !r.infoHash)) return '';
  return `${r.seeders} ${word}`;
}

function Meta({ icon, text, accent }: { icon: any; text: string; accent?: boolean }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, height: 30, borderRadius: R.pill, backgroundColor: accent ? 'rgba(255,181,71,0.15)' : C.elevated }}>
      <Ionicons name={icon} size={14} color={accent ? C.accent : C.sub} />
      <Text style={{ color: accent ? C.accent : C.sub, fontSize: 12, fontWeight: '600' }}>{text}</Text>
    </View>
  );
}

function ResultRow({ r, cached, state, onAdd, onPress }: { r: SearchResult; cached: boolean; state?: AddState; onAdd: () => void; onPress: () => void }) {
  const bits = [r.size, r.duration, seedText(r, 'seeds')].filter(Boolean).join('  ·  ');
  const byline = [r.author, r.narrator ? `read by ${r.narrator}` : ''].filter(Boolean).join('  ·  ');
  return (
    <Tap onPress={onPress} scaleTo={0.98} hoverStyle={{ backgroundColor: C.hover }} style={{ flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 20, paddingVertical: 10 }}>
      <Cover title={r.title} uri={r.cover} size={64} radius={10} />
      <View style={{ flex: 1, gap: 3 }}>
        <Text numberOfLines={2} style={[T.title, { fontSize: 15 }]}>{r.title}</Text>
        {byline ? <Text numberOfLines={1} style={T.body}>{byline}</Text> : null}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 }}>
          {cached && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2, backgroundColor: 'rgba(255,181,71,0.15)', borderRadius: 6, paddingHorizontal: 5, paddingVertical: 1 }}>
              <Ionicons name="flash" size={10} color={C.accent} /><Text style={{ color: C.accent, fontSize: 10, fontWeight: '800' }}>INSTANT</Text>
            </View>
          )}
          {isFullCast(r) && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2, backgroundColor: 'rgba(74,222,128,0.15)', borderRadius: 6, paddingHorizontal: 5, paddingVertical: 1 }}>
              <Ionicons name="people" size={10} color={C.good} /><Text style={{ color: C.good, fontSize: 10, fontWeight: '800' }}>FULL CAST</Text>
            </View>
          )}
          <Text numberOfLines={1} style={[T.small, { flex: 1 }]}>{r.icon ? `${r.icon} ` : ''}{bits || r.scraperName}</Text>
        </View>
      </View>
      <Tap onPress={onAdd} hitSlop={8} scaleTo={0.85} accessibilityLabel={state === 'added' ? `Sent ${r.title} to TorBox` : `Send ${r.title} to TorBox`} style={{
        width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center',
        backgroundColor: state === 'added' ? 'rgba(74,222,128,0.15)' : C.elevated, borderWidth: 1, borderColor: state === 'added' ? C.good : C.line,
      }}>
        {state === 'adding' ? <ActivityIndicator size="small" color={C.accent} /> : (
          <Pop on={state === 'added'} from={0.3}>
            <Ionicons name={state === 'added' ? 'checkmark' : 'add'} size={22} color={state === 'added' ? C.good : C.text} />
          </Pop>
        )}
      </Tap>
    </Tap>
  );
}
