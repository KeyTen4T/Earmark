import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, TextInput, ScrollView, Modal, Share } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { C, R, T } from '../theme';
import { Tap, Button, IconButton, toast, useKeyboardHeight } from './ui';
import { useEscape } from '../escape';
import { runSearch, ScraperDef, SearchResult, SearchTrace } from '../scrapers/engine';
import { parseScrapers } from '../scrapers/importer';

type TestRun = { busy: boolean; error?: string; trace?: SearchTrace; results?: SearchResult[] };

/**
 * Full-screen workbench for one source: edit its JSON, test a search against the edited
 * version without saving, then save, duplicate, share or remove it.
 */
export function SourceEditor({ source, readOnly, isNew, takenIds, onClose, onSave, onDuplicate, onRemove }: {
  source: ScraperDef;
  readOnly?: boolean; // built-in sources can be tested and duplicated, not changed
  isNew?: boolean;
  takenIds: string[]; // ids of every other source
  onClose: () => void;
  onSave: (def: ScraperDef) => void;
  onDuplicate: (def: ScraperDef) => void;
  onRemove?: () => void;
}) {
  const insets = useSafeAreaInsets();
  const kb = useKeyboardHeight();
  const original = useMemo(() => JSON.stringify(source, null, 2), [source]);
  const [text, setText] = useState(original);
  const [query, setQuery] = useState('');
  const [test, setTest] = useState<TestRun | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  useEffect(() => { setText(original); setTest(null); }, [original]);

  // Re-validated on every keystroke so mistakes show up before saving or testing.
  const parsed = useMemo((): { def?: ScraperDef; error?: string } => {
    try {
      const defs = parseScrapers(text);
      if (defs.length !== 1) return { error: 'The editor holds one source at a time' };
      if (takenIds.includes(defs[0].id)) return { error: `Another source already uses the id "${defs[0].id}"` };
      return { def: defs[0] };
    } catch (e: any) { return { error: e.message ?? 'Invalid' }; }
  }, [text, takenIds]);
  const dirty = text !== original;

  const runTest = async () => {
    if (!parsed.def || !query.trim()) return;
    const trace: SearchTrace = {};
    setTest({ busy: true });
    try {
      const results = await runSearch(parsed.def, query.trim(), fetch, 1, trace);
      setTest({ busy: false, trace, results });
    } catch (e: any) {
      setTest({ busy: false, trace, error: e.message ?? 'Search failed' });
    }
  };

  const close = () => {
    if (dirty && !readOnly) toast('Changes discarded');
    onClose();
  };
  useEscape(close, true);

  const input = { backgroundColor: C.surface, color: C.text, borderRadius: R.md, borderWidth: 1, borderColor: C.line, padding: 12 } as const;
  const tr = test?.trace;

  return (
    <Modal visible animationType="slide" onRequestClose={close} statusBarTranslucent>
      <View style={{ flex: 1, backgroundColor: C.bg }}>
      <View style={{ flex: 1, paddingTop: insets.top + 6, width: '100%', maxWidth: 860, alignSelf: 'center' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, gap: 4 }}>
          <IconButton label="Close editor" name="chevron-down" onPress={close} size={26} />
          <View style={{ flex: 1 }}>
            <Text style={T.label}>{readOnly ? 'Built-in source' : isNew ? 'New source' : 'Edit source'}</Text>
            <Text numberOfLines={1} style={[T.title, { marginTop: 2 }]}>{parsed.def?.name ?? source.name}</Text>
          </View>
          {!readOnly && (
            <Button label="Save" icon="checkmark" disabled={!parsed.def || (!dirty && !isNew)}
              onPress={() => parsed.def && onSave(parsed.def)} />
          )}
        </View>

        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 20, paddingBottom: (kb || insets.bottom) + 28, gap: 12 }}>
          <Text style={T.label}>Test a search</Text>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <TextInput value={query} onChangeText={setQuery} onSubmitEditing={runTest} returnKeyType="search" accessibilityLabel="Test search query"
              placeholder="e.g. Sherlock Holmes" placeholderTextColor={C.faint} style={[input, { flex: 1, height: 50 }]} />
            <Button kind="ghost" label="Test" icon="flask-outline" loading={test?.busy} disabled={!parsed.def || !query.trim()} onPress={runTest} />
          </View>
          <Text style={T.small}>Runs the JSON below as it is now, saved or not.</Text>

          {test && !test.busy ? (
            <View style={{ backgroundColor: C.surface, borderRadius: R.md, borderWidth: 1, borderColor: test.error ? C.danger : C.line, padding: 12, gap: 8 }}>
              {test.error ? <Text style={{ color: C.danger, fontWeight: '700' }}>{test.error}</Text> : null}
              {tr?.rows != null ? (
                <Text style={T.body}>
                  <Text style={{ color: C.text, fontWeight: '700' }}>{tr.addable ?? 0} usable</Text>
                  {` of ${tr.rows} rows`}{tr.ms != null ? ` · ${(tr.ms / 1000).toFixed(1)}s` : ''}
                  {tr.afterWhere != null && tr.afterWhere < tr.rows ? `\n${tr.rows - tr.afterWhere} skipped by "where"` : ''}
                  {tr.afterWhere != null && tr.addable != null && tr.addable < tr.afterWhere ? `\n${tr.afterWhere - tr.addable} had no magnet, infoHash or torrentUrl` : ''}
                </Text>
              ) : null}
              {tr?.url ? <Text selectable numberOfLines={3} style={[T.small, { fontFamily: 'monospace' }]}>{tr.url}</Text> : null}
              {(test.results ?? []).slice(0, 6).map((r) => (
                <View key={r.id} style={{ borderTopWidth: 1, borderTopColor: C.line, paddingTop: 8 }}>
                  <Text numberOfLines={1} style={T.title}>{r.title}</Text>
                  <Text numberOfLines={1} style={T.small}>
                    {[r.author, r.size, r.seeders && `${r.seeders} seeds`, r.magnet ? 'magnet' : r.infoHash ? 'infoHash' : r.torrentUrl ? 'torrentUrl' : 'detail page', r.cover && 'cover'].filter(Boolean).join(' · ')}
                  </Text>
                </View>
              ))}
              {tr?.sample ? (
                <>
                  <Tap onPress={() => setShowRaw((v) => !v)} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingTop: 4 }}>
                    <Ionicons name={showRaw ? 'chevron-down' : 'chevron-forward'} size={14} color={C.accent} />
                    <Text style={{ color: C.accent, fontWeight: '700', fontSize: 13 }}>First raw row (the names you can use in templates)</Text>
                  </Tap>
                  {showRaw ? <Text selectable style={{ color: C.sub, fontFamily: 'monospace', fontSize: 11 }}>{JSON.stringify(tr.sample, null, 2).slice(0, 4000)}</Text> : null}
                </>
              ) : null}
            </View>
          ) : null}

          <Text style={[T.label, { marginTop: 8 }]}>Definition</Text>
          <TextInput value={text} onChangeText={setText} editable={!readOnly} multiline autoCapitalize="none" autoCorrect={false} spellCheck={false} accessibilityLabel="Source definition"
            style={[input, { minHeight: 260, textAlignVertical: 'top', fontFamily: 'monospace', fontSize: 12, color: readOnly ? C.sub : C.text }]} />
          {parsed.error ? (
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Ionicons name="warning-outline" size={16} color={C.danger} />
              <Text style={{ color: C.danger, flex: 1, fontSize: 13 }}>{parsed.error}</Text>
            </View>
          ) : (
            <Text style={[T.small, { color: C.good }]}>Valid{dirty && !readOnly ? ' · unsaved changes' : ''}</Text>
          )}

          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
            <Button kind="ghost" icon="copy-outline" label={readOnly ? 'Duplicate to edit' : 'Duplicate'} disabled={!parsed.def}
              onPress={() => parsed.def && onDuplicate(parsed.def)} />
            <Button kind="ghost" icon="share-outline" label="Share" onPress={() => Share.share({ message: text }).catch(() => {})} />
            {dirty && !readOnly ? <Button kind="ghost" icon="arrow-undo-outline" label="Revert" onPress={() => setText(original)} /> : null}
          </View>
          {onRemove ? <Button kind="danger" icon="trash-outline" label="Remove source" onPress={onRemove} /> : null}
        </ScrollView>
      </View>
      </View>
    </Modal>
  );
}
