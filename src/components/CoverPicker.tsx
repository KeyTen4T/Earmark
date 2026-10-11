import React, { useEffect, useRef, useState } from 'react';
import { View, Text, TextInput, ScrollView, Image, ActivityIndicator, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { C, R, T } from '../theme';
import { Tap, Sheet, Button, toast } from './ui';
import { TBTorrent } from '../torbox';
import { BookMeta, saveMeta } from '../storage';
import { COVER_SOURCES, CoverOption, coverQuery } from '../covers';
import { usePlayer } from '../player/PlayerContext';

type SourceState = { busy: boolean; options: CoverOption[]; error?: string };

/** Searches every cover source for a book and lets the user pick one. */
import { useLayout } from '../layout';
export function CoverPicker({ visible, onClose, book, meta, onSaved }: {
  visible: boolean; onClose: () => void; book: TBTorrent; meta: BookMeta; onSaved: (all: Record<string, BookMeta>) => void;
}) {
  const player = usePlayer();
  const { height } = useWindowDimensions();
  const { dialogWidth: width } = useLayout();
  const defaultQuery = coverQuery(meta.title ? `${meta.title} ${meta.author ?? ''}` : book.name);
  const [q, setQ] = useState(defaultQuery);
  const [results, setResults] = useState<Record<string, SourceState>>({});
  const run = useRef(0);

  const search = (query = q) => {
    const text = query.trim();
    if (!text) return;
    const my = ++run.current;
    setResults(Object.fromEntries(COVER_SOURCES.map((s) => [s.name, { busy: true, options: [] }])));
    COVER_SOURCES.forEach(async (s) => {
      let next: SourceState;
      try { next = { busy: false, options: await s.search(text) }; }
      catch (e: any) { next = { busy: false, options: [], error: e.message ?? 'failed' }; }
      if (my === run.current) setResults((prev) => ({ ...prev, [s.name]: next }));
    });
  };

  useEffect(() => {
    if (visible) { setQ(defaultQuery); search(defaultQuery); }
  }, [visible]);

  const save = async (cover: string) => {
    try {
      const all = await saveMeta(book.hash, { cover });
      player.updateMeta(book.id, { cover });
      onSaved(all);
      toast(cover ? 'Cover updated' : 'Cover removed');
      onClose();
    } catch (e: any) {
      toast(e.message ?? 'Could not save cover', 'err');
    }
  };

  // The same image can come back from more than one source; show it once, under the first.
  const seen = new Set<string>();
  const sections = COVER_SOURCES.map((s) => {
    const st = results[s.name];
    const options = (st?.options ?? []).filter((o) => !seen.has(o.uri) && seen.add(o.uri));
    return { name: s.name, st, options };
  }).filter((x) => x.st && (x.st.busy || x.options.length || x.st.error));
  const anyBusy = sections.some((x) => x.st?.busy);

  const gap = 10;
  const tile = (width - 40 - gap * 2) / 3;

  return (
    <Sheet visible={visible} onClose={onClose} title="Choose a cover">
      <View style={{ paddingHorizontal: 20, marginBottom: 8 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: C.bg, borderRadius: R.md, borderWidth: 1, borderColor: C.line, paddingHorizontal: 12, height: 48 }}>
          <Ionicons name="search" size={18} color={C.faint} />
          <TextInput value={q} onChangeText={setQ} onSubmitEditing={() => search()} returnKeyType="search" placeholderTextColor={C.faint} accessibilityLabel="Search covers"
            placeholder="Title and author" style={{ flex: 1, color: C.text, marginLeft: 8 }} />
          {anyBusy ? <ActivityIndicator color={C.accent} /> : null}
        </View>
      </View>
      <ScrollView style={{ maxHeight: height * 0.58 }} contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 12 }} keyboardShouldPersistTaps="handled">
        {sections.map(({ name, st, options }) => (
          <View key={name} style={{ marginTop: 10 }}>
            <Text style={[T.label, { marginBottom: 8 }]}>{name}</Text>
            {st!.busy && !options.length ? <ActivityIndicator color={C.accent} style={{ alignSelf: 'flex-start', marginVertical: 8 }} /> : null}
            {st!.error ? <Text style={T.small}>Couldn’t search: {st!.error}</Text> : null}
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap }}>
              {options.map((o) => <CoverTile key={o.uri} option={o} size={tile} current={o.uri === meta.cover} onPress={() => save(o.uri)} />)}
            </View>
          </View>
        ))}
        {!anyBusy && !sections.some((x) => x.options.length) ? (
          <Text style={[T.body, { textAlign: 'center', padding: 24 }]}>No covers found. Try just the title, or title and author.</Text>
        ) : null}
        {meta.cover ? <Button kind="ghost" icon="close-circle-outline" label="Remove cover" style={{ marginTop: 18 }} onPress={() => save('')} /> : null}
      </ScrollView>
    </Sheet>
  );
}

function CoverTile({ option, size, current, onPress }: { option: CoverOption; size: number; current: boolean; onPress: () => void }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null; // dead link or a blank placeholder image
  return (
    <Tap onPress={onPress} scaleTo={0.95} accessibilityLabel={option.label ? `Use cover: ${option.label}` : 'Use this cover'} accessibilityState={{ selected: current }} style={{ width: size }}>
      <View style={{ width: size, height: size, borderRadius: R.sm, overflow: 'hidden', backgroundColor: C.elevated, borderWidth: current ? 3 : 0, borderColor: C.accent }}>
        <Image source={{ uri: option.uri }} style={{ width: '100%', height: '100%' }} resizeMode="cover"
          onError={() => setFailed(true)} onLoad={(e) => { const s = e.nativeEvent.source; if (s && s.width < 10) setFailed(true); }} />
        {current ? (
          <View style={{ position: 'absolute', top: 6, right: 6, backgroundColor: C.accent, borderRadius: 12, padding: 2 }}>
            <Ionicons name="checkmark" size={14} color={C.accentInk} />
          </View>
        ) : null}
      </View>
      {option.label ? <Text numberOfLines={1} style={[T.small, { marginTop: 4, fontSize: 11 }]}>{option.label}</Text> : null}
    </Tap>
  );
}
