import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, ScrollView, Switch, Linking, useWindowDimensions, Animated, Platform, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { C, R, T } from '../theme';
import app from '../../app.json';
import { Tap, Sheet, Button, Chip, toast, IconName, IconButton, useKeyboardHeight, HeroHeader, StickyBar, useScrollY, FadeIn, confirmAction, Input, tvFocusRing } from '../components/ui';
import type { ScraperDef } from '../scrapers/engine';
import { pickScraperFiles, fetchScrapers, parseScrapers, EXAMPLE_SCRAPER } from '../scrapers/importer';
import { makeBackupFile, makeSetupFile, pickImportFile, applyBackupFile, applySetupFile, exportBackupFile } from '../backup-io';
import { backupSummary, setupSummary, type ImportFile } from '../backup';
import { usePlayer } from '../player/PlayerContext';
import { SourceEditor } from '../components/SourceEditor';
import { AiProvider, providerFor, providerName, pickModel, cleanKey } from '../recommend';
import {
  getAiKey, setAiKey,
  loadReadalongServerUrl, saveReadalongServerUrl, getReadalongServerToken,
  setReadalongServerToken, clearReadalongServer,
  loadEbookSearchUrl, saveEbookSearchUrl,
  saveDismissedUpdate, loadRemovedReadElsewhere,
} from '../storage';
import { checkForUpdate, openUpdate, currentVersion, knownUpdate, setKnownUpdate, subscribeUpdate } from '../update';
import { summary, type Release } from '../update-check';
import { testServer, normalizeServerUrl } from '../readalong/server';
import { isHttpUrl } from '../readalong/ebookSearch';
import { fetchMe, setHcToken, getHcToken, cachedMe, fetchHardcoverHistory, HcUser } from '../hardcover';
import { pickGoodreadsExport, applyReadingPlan } from '../reading-import';
import { planReadingImport, type ImportPlan, type LibraryBook, type ReadElsewhere } from '../reading-history';
import { getSyncStatus, subscribeSyncStatus, connectSync, disconnectSync, syncNow, type SyncStatus } from '../sync';
import { getDownloads, subscribeDownloads, totalBytesUsed, removeAllDownloads } from '../downloads';
import { formatBytes } from '../scrapers/template';
import type { Downloads } from '../downloads/state';
import { toggleNarrator } from '../narrators';
import { isTV } from '../layout';

export function SettingsScreen({ builtins, userScrapers, disabled, narrators, library, readElsewhere, onScrapers, onDisabled, onNarrators, onReadElsewhere, onImported, onSignOut, bottomPad }: {
  builtins: ScraperDef[];
  userScrapers: ScraperDef[];
  disabled: string[];
  narrators: string[];
  library: LibraryBook[];
  readElsewhere: ReadElsewhere[];
  onScrapers: (s: ScraperDef[]) => void;
  onDisabled: (ids: string[]) => void;
  onNarrators: (list: string[]) => void;
  onReadElsewhere: (list: ReadElsewhere[]) => void;
  onImported: () => void;
  onSignOut: () => void;
  bottomPad: number;
}) {
  const insets = useSafeAreaInsets();
  const player = usePlayer();
  const { y, onScroll } = useScrollY();
  const [editing, setEditing] = useState<{ source: ScraperDef; isNew?: boolean } | null>(null);
  const [importMode, setImportMode] = useState<null | 'url' | 'paste'>(null);
  const [importText, setImportText] = useState('');
  const [busy, setBusy] = useState(false);
  const [formatOpen, setFormatOpen] = useState(false);
  const [hcUser, setHcUser] = useState<HcUser | null>(null);
  const [hcOpen, setHcOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiProvider, setAiProvider] = useState<AiProvider | null>(null);
  const [syncOpen, setSyncOpen] = useState(false);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>(() => getSyncStatus());
  useEffect(() => subscribeSyncStatus(setSyncStatus), []);
  const [importData, setImportData] = useState<ImportFile | null>(null);
  const [backupBusy, setBackupBusy] = useState<null | 'export' | 'setup' | 'merge' | 'replace'>(null);
  const [downloads, setDownloads] = useState<Downloads>(() => getDownloads());
  useEffect(() => subscribeDownloads(setDownloads), []);
  const [checking, setChecking] = useState(false);
  const [known, setKnown] = useState<Release | null>(() => knownUpdate());
  useEffect(() => subscribeUpdate(() => setKnown(knownUpdate())), []);
  useEffect(() => { getAiKey().then((k) => setAiProvider(k ? providerFor(k) : null)); }, []);
  const [raOpen, setRaOpen] = useState(false);
  const [raServer, setRaServer] = useState<{ url: string; token: boolean } | null>(null);
  const reloadRaServer = useCallback(() => {
    Promise.all([loadReadalongServerUrl(), getReadalongServerToken()])
      .then(([u, t]) => setRaServer({ url: u, token: !!t }), () => setRaServer({ url: '', token: false }));
  }, []);
  useEffect(() => { reloadRaServer(); }, [reloadRaServer]);
  const [ebookOpen, setEbookOpen] = useState(false);
  const [narratorsOpen, setNarratorsOpen] = useState(false);
  const [ebookUrl, setEbookUrl] = useState('');
  const reloadEbookUrl = useCallback(() => {
    loadEbookSearchUrl().then(setEbookUrl, () => setEbookUrl(''));
  }, []);
  useEffect(() => { reloadEbookUrl(); }, [reloadEbookUrl]);

  useEffect(() => { getHcToken().then((t) => (t ? cachedMe().then(setHcUser) : null)); }, []);

  // Long pasted JSON scrolls inside the box, so the Import button under it always stays on screen.
  const { height } = useWindowDimensions();
  const kb = useKeyboardHeight();
  const pasteMax = Math.max(90, (kb ? height - kb - insets.top : height * 0.8) - 210);

  const all = [...builtins, ...userScrapers];
  const builtinIds = new Set(builtins.map((s) => s.id));

  const install = (defs: ScraperDef[], errors: string[] = []) => {
    if (errors.length) toast(errors[0], 'err');
    if (!defs.length) return;
    const next = [...userScrapers];
    let added = 0, updated = 0;
    for (const d of defs) {
      if (builtinIds.has(d.id)) { toast(`"${d.id}" clashes with a built-in source; change its id`, 'err'); continue; }
      const i = next.findIndex((s) => s.id === d.id);
      if (i >= 0) { next[i] = d; updated++; } else { next.push(d); added++; }
    }
    onScrapers(next);
    if (added + updated) toast([added && `${added} added`, updated && `${updated} updated`].filter(Boolean).join(', '));
  };

  const importFile = async () => {
    try { const r = await pickScraperFiles(); if (r) install(r.defs, r.errors); }
    catch (e: any) { toast(e.message, 'err'); }
  };

  const importOther = async () => {
    setBusy(true);
    try {
      const defs = importMode === 'url' ? await fetchScrapers(importText.trim()) : parseScrapers(importText);
      install(defs);
      setImportMode(null); setImportText('');
    } catch (e: any) { toast(e.message, 'err'); }
    finally { setBusy(false); }
  };

  // Saving replaces the source that was opened (even if its id was edited); a new one is appended.
  const saveSource = (def: ScraperDef) => {
    if (!editing) return;
    const i = editing.isNew ? -1 : userScrapers.findIndex((s) => s.id === editing.source.id);
    onScrapers(i >= 0 ? userScrapers.map((s, j) => (j === i ? def : s)) : [...userScrapers, def]);
    if (!editing.isNew && def.id !== editing.source.id) onDisabled(disabled.map((d) => (d === editing.source.id ? def.id : d)));
    setEditing({ source: def });
    toast('Source saved');
  };

  // Opens an unsaved copy with a free id, so the original stays untouched.
  const duplicateSource = (def: ScraperDef) => {
    const ids = new Set(all.map((s) => s.id));
    let id = `${def.id}-copy`;
    for (let n = 2; ids.has(id); n++) id = `${def.id}-copy${n}`;
    setEditing({ source: { ...def, id, name: `${def.name} (copy)` }, isNew: true });
  };

  const newSource = () => {
    const ids = new Set(all.map((s) => s.id));
    const def = JSON.parse(EXAMPLE_SCRAPER) as ScraperDef;
    for (let n = 2; ids.has(def.id); n++) def.id = `my-source-${n}`;
    setEditing({ source: def, isNew: true });
  };

  const toggle = (id: string, on: boolean) => onDisabled(on ? disabled.filter((d) => d !== id) : [...disabled, id]);

  const removeAll = async () => {
    if (!(await confirmAction('Remove all downloads?', 'Every downloaded book is deleted from this device. You can download them again later.', 'Remove all'))) return;
    await removeAllDownloads();
    toast('Downloads removed');
  };

  const signOut = async () => {
    if (!(await confirmAction('Sign out of TorBox?', 'This removes your API key from this device. Your books stay in TorBox.', 'Sign out'))) return;
    onSignOut();
  };

  const exportData = async () => {
    if (backupBusy) return;
    setBackupBusy('export');
    try {
      const r = await exportBackupFile(await makeBackupFile());
      if (r === 'saved') toast('Backup saved');
    } catch (e: any) { toast(e?.message ?? 'Could not export data', 'err'); }
    finally { setBackupBusy(null); }
  };

  // The setup file is a copy of the source definitions, so a source's address may carry personal ids.
  const shareSetup = async () => {
    if (backupBusy) return;
    if (!(await confirmAction('Share my setup?',
      'The file contains your source definitions exactly as they are on this device. A source’s address can include personal IDs, so only send it to people you trust.',
      'Share'))) return;
    setBackupBusy('setup');
    try {
      const r = await exportBackupFile(await makeSetupFile());
      if (r === 'saved') toast('Setup saved');
    } catch (e: any) { toast(e?.message ?? 'Could not share your setup', 'err'); }
    finally { setBackupBusy(null); }
  };

  const pickImport = async () => {
    try {
      const f = await pickImportFile();
      if (f) setImportData(f);
    } catch (e: any) { toast(e?.message ?? 'Could not read that file', 'err'); }
  };

  const applyImport = async (mode: 'merge' | 'replace') => {
    if (!importData || importData.kind !== 'backup') return;
    if (mode === 'replace' && !(await confirmAction('Replace all data on this device?',
      `This overwrites progress, ratings and the rest on this device${syncStatus.connected ? ', and — with sync on — on your other devices' : ''}.`,
      'Replace'))) return;
    setBackupBusy(mode);
    try {
      const s = backupSummary(importData);
      const next = await applyBackupFile(importData, mode);
      onScrapers(next.sources);
      onDisabled(next.disabled);
      onNarrators(next.narrators);
      onReadElsewhere(next.readElsewhere);
      reloadEbookUrl();
      reloadRaServer();
      setImportData(null);
      toast(`${mode === 'replace' ? 'Replaced' : 'Merged'}: ${s.withProgress} books with progress, ${s.sources} sources`);
    } catch (e: any) { toast(e?.message ?? 'Could not import the backup', 'err'); }
    finally { setBackupBusy(null); }
  };

  // A setup file only adds: sources it carries that are not here, and the search address if unset.
  const addSetup = async () => {
    if (!importData || importData.kind !== 'setup' || backupBusy) return;
    setBackupBusy('setup');
    try {
      const have = new Set(userScrapers.map((s) => s.id));
      const added = importData.data.sources.filter((s) => !have.has(s.id)).length;
      const next = await applySetupFile(importData);
      onScrapers(next.sources);
      reloadEbookUrl();
      setImportData(null);
      toast(added ? `Added ${added} source${added === 1 ? '' : 's'}` : 'No new sources to add');
    } catch (e: any) { toast(e?.message ?? 'Could not add the setup', 'err'); }
    finally { setBackupBusy(null); }
  };

  // The manual check ignores both the 24 h throttle and the version the user dismissed.
  const checkUpdates = async () => {
    if (checking) return;
    setChecking(true);
    try {
      const { release, newer } = await checkForUpdate();
      if (!newer) { toast(`Earmark ${currentVersion()} is the latest version`); return; }
      setKnownUpdate(release);
      const body = `${summary(release.notes, 6)}\nYou have ${currentVersion()}.`;
      if (await confirmAction(`Earmark ${release.version} is available`, body, 'Download')) openUpdate(release);
      else await saveDismissedUpdate(release.version);
    } catch (e: any) {
      toast(e.message ?? 'Could not check for updates', 'err');
    } finally {
      setChecking(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Animated.ScrollView onScroll={onScroll} scrollEventThrottle={16} contentContainerStyle={{ paddingTop: insets.top + 12, paddingBottom: bottomPad + 24, paddingHorizontal: 20, maxWidth: 720 }}>
        <HeroHeader y={y} label="Make it yours" title="Settings" style={{ marginBottom: 22 }} />

        <Section title="Sources" action={<Tap onPress={() => setFormatOpen(true)}><Text style={{ color: C.accent, fontWeight: '700' }}>Format guide</Text></Tap>}>
          {all.map((s, i) => {
            const on = !disabled.includes(s.id);
            return (
              <Row key={s.id} last={i === all.length - 1} onPress={() => setEditing({ source: s })}
                left={<View style={{ width: 38, height: 38, borderRadius: 10, backgroundColor: C.elevated, alignItems: 'center', justifyContent: 'center' }}>
                  <Text style={{ fontSize: 18 }}>{s.icon ?? '🔎'}</Text></View>}
                title={s.name}
                sub={`${builtinIds.has(s.id) ? 'Built-in' : 'Imported'} · ${s.type.toUpperCase()}${s.version ? ` · v${s.version}` : ''}`}
                right={<FocusSwitch value={on} onValueChange={(v) => toggle(s.id, v)} accessibilityLabel={`Enable ${s.name}`}
                  trackColor={{ false: C.line, true: C.accent }} thumbColor={C.text}
                  {...({ activeThumbColor: C.text, activeTrackColor: C.accent } as any)} />} />
            );
          })}
        </Section>
        <Text style={[T.small, { marginTop: -12, marginBottom: 12 }]}>Tap a source to edit it and test searches.</Text>
        <View style={{ flexDirection: 'row', gap: 8, marginBottom: 8 }}>
          {!isTV && <Button label="Import file" icon="document-attach-outline" onPress={importFile} style={{ flex: 1 }} />}
          <Button kind="ghost" label="New" icon="add" onPress={newSource} style={{ flex: 1 }} />
        </View>
        <View style={{ flexDirection: 'row', gap: 8, marginBottom: 26 }}>
          <Button kind="ghost" label="From URL" icon="link-outline" onPress={() => setImportMode('url')} style={{ flex: 1 }} />
          <Button kind="ghost" label="Paste" icon="clipboard-outline" onPress={() => setImportMode('paste')} style={{ flex: 1 }} />
        </View>

        <Section title="Tracking">
          <Row onPress={() => setHcOpen(true)}
            left={<Badge icon="bookmarks" color="#7C5CFF" />}
            title="Hardcover"
            sub={hcUser ? `Connected as @${hcUser.username}` : 'Sync progress and finished books'}
            right={<Ionicons name="chevron-forward" size={18} color={C.faint} />} />
          <Row onPress={() => setHistoryOpen(true)}
            left={<Badge icon="time-outline" color="#7C5CFF" />}
            title="Import reading history"
            sub="Books you finished elsewhere, for the Finished shelf"
            right={<Ionicons name="chevron-forward" size={18} color={C.faint} />} />
          <Row last onPress={() => setNarratorsOpen(true)}
            left={<Badge icon="heart" color="#FF6B6B" />}
            title="Narrators you follow"
            sub={narrators.length ? `${narrators.length} followed` : 'Follow narrators from a search result'}
            right={<Ionicons name="chevron-forward" size={18} color={C.faint} />} />
        </Section>

        <Section title="Sync">
          <Row last onPress={() => setSyncOpen(true)}
            left={<Badge icon="sync-outline" color="#3D7BFF" />}
            title="Phone ⇄ desktop"
            sub={!syncStatus.connected ? 'Sync progress across your devices'
              : syncStatus.versionTooNew ? 'Update the app to sync'
              : syncStatus.error ? syncStatus.error
              : syncStatus.lastSyncAt ? `Synced ${relativeTime(syncStatus.lastSyncAt)}` : 'Connected'}
            right={<Ionicons name="chevron-forward" size={18} color={C.faint} />} />
        </Section>

        <Section title="Backup">
          {isTV ? (
            <Text style={[T.body, { padding: 14 }]}>Backups are made from the phone or desktop app.</Text>
          ) : (
            <>
              <Row onPress={exportData}
                left={<Badge icon="download-outline" color="#4ADE80" />}
                title="Export data"
                sub="Save progress, ratings, sources and settings to a file"
                right={backupBusy === 'export' ? <ActivityIndicator color={C.accent} /> : <Ionicons name="chevron-forward" size={18} color={C.faint} />} />
              <Row onPress={shareSetup}
                left={<Badge icon="share-social-outline" color="#4ADE80" />}
                title="Share my setup"
                sub="A file with your sources and search address, for another person"
                right={backupBusy === 'setup' ? <ActivityIndicator color={C.accent} /> : <Ionicons name="chevron-forward" size={18} color={C.faint} />} />
              <Row last onPress={pickImport}
                left={<Badge icon="cloud-upload-outline" color="#4ADE80" />}
                title="Import data"
                sub="Restore from a backup or setup file"
                right={<Ionicons name="chevron-forward" size={18} color={C.faint} />} />
            </>
          )}
        </Section>
        {!isTV && <Text style={[T.small, { marginTop: -12, marginBottom: 12 }]}>Keys and tokens are never included in a backup or setup file.</Text>}

        <Section title="Read-along">
          <Row onPress={() => setRaOpen(true)}
            left={<Badge icon="book-outline" color="#E08D3C" />}
            title="Read-along server"
            sub={raServer?.url && raServer.token ? 'Connected — books build on the server'
              : raServer?.url ? 'Add the token to finish setup'
              : 'Not set — books build on the computer'}
            right={<Ionicons name="chevron-forward" size={18} color={C.faint} />} />
          <Row last onPress={() => setEbookOpen(true)}
            left={<Badge icon="search" color="#E08D3C" />}
            title="EPUB search address"
            sub={ebookUrl ? 'Set — searches this address for EPUBs' : 'Not set — read-alongs can’t search for EPUBs'}
            right={<Ionicons name="chevron-forward" size={18} color={C.faint} />} />
        </Section>

        <Section title="Recommendations">
          <Row last onPress={() => setAiOpen(true)}
            left={<Badge icon="sparkles" color="#2BB673" />}
            title="Personal picks"
            sub={aiProvider ? `Using ${providerName(aiProvider)} for Surprise me` : 'Add a Gemini, Groq or Grok key'}
            right={<Ionicons name="chevron-forward" size={18} color={C.faint} />} />
        </Section>

        <Section title="Playback">
          <View style={{ padding: 14, gap: 10 }}>
            <Text style={T.body}>Skip back</Text>
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              {[5, 10, 15, 30, 45].map((n) => <Chip key={n} label={`${n}s`} active={player.skipBack === n} onPress={() => player.setSkips(n, player.skipForward)} />)}
            </View>
            <Text style={[T.body, { marginTop: 6 }]}>Skip forward</Text>
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              {[10, 15, 30, 45, 60].map((n) => <Chip key={n} label={`${n}s`} active={player.skipForward === n} onPress={() => player.setSkips(player.skipBack, n)} />)}
            </View>
          </View>
        </Section>

        {Platform.OS !== 'web' && (
          <Section title="Downloads">
            <View style={{ padding: 14, gap: 12 }}>
              <Text style={T.body}>
                {totalBytesUsed() > 0
                  ? `${formatBytes(totalBytesUsed())} of books stored on this device for offline listening.`
                  : 'No books downloaded for offline listening yet.'}
              </Text>
              <Button kind="danger" icon="trash-outline" label="Remove all downloads"
                disabled={Object.keys(downloads).length === 0} onPress={removeAll} />
            </View>
          </Section>
        )}

        <Section title="Account">
          <Row last onPress={signOut} left={<Badge icon="log-out-outline" color={C.danger} />} title="Sign out of TorBox" sub="Removes your API key from this device" />
        </Section>

        <Section title="Updates">
          <Row last onPress={checkUpdates}
            left={<Badge icon="cloud-download-outline" color={C.accent} />}
            title="Check for updates"
            sub={checking ? 'Checking…' : known ? `${known.version} available` : `Earmark ${app.expo.version}`}
            right={checking ? <ActivityIndicator color={C.accent} /> : <Ionicons name="chevron-forward" size={18} color={C.faint} />} />
        </Section>

        <Text style={[T.small, { textAlign: 'center', marginTop: 8 }]}>Earmark {app.expo.version} · streams from your own TorBox account</Text>
      </Animated.ScrollView>
      <StickyBar y={y} title="Settings" />

      {editing && (
        <SourceEditor source={editing.source} isNew={editing.isNew} readOnly={builtinIds.has(editing.source.id) && !editing.isNew}
          takenIds={all.map((x) => x.id).filter((id) => editing.isNew || id !== editing.source.id)}
          onClose={() => setEditing(null)} onSave={saveSource} onDuplicate={duplicateSource}
          onRemove={editing.isNew || builtinIds.has(editing.source.id) ? undefined : () => {
            onScrapers(userScrapers.filter((x) => x.id !== editing.source.id)); setEditing(null); toast('Source removed');
          }} />
      )}

      <Sheet visible={!!importMode} onClose={() => setImportMode(null)} title={importMode === 'url' ? 'Import from URL' : 'Paste scraper JSON'}>
        <View style={{ paddingHorizontal: 20, gap: 12 }}>
          <Input value={importText} onChangeText={setImportText} autoCapitalize="none" autoCorrect={false} accessibilityLabel={importMode === 'url' ? 'Scraper URL' : 'Scraper JSON'}
            multiline={importMode === 'paste'} placeholder={importMode === 'url' ? 'https://…/scraper.json' : '{ "id": "…", … }'} placeholderTextColor={C.faint}
            style={{ backgroundColor: C.bg, color: C.text, borderRadius: R.md, padding: 14, borderWidth: 1, borderColor: C.line, minHeight: importMode === 'paste' ? Math.min(180, pasteMax) : 52, maxHeight: importMode === 'paste' ? pasteMax : 120, textAlignVertical: 'top', fontFamily: importMode === 'paste' ? 'monospace' : undefined, fontSize: 13 }} />
          <Button label="Import" icon="download-outline" onPress={importOther} loading={busy} disabled={!importText.trim()} />
        </View>
      </Sheet>

      <Sheet visible={formatOpen} onClose={() => setFormatOpen(false)} title="Scraper format">
        <ScrollView style={{ paddingHorizontal: 20 }} contentContainerStyle={{ gap: 10, paddingBottom: 12 }}>
          <Text style={T.body}>A scraper is a .json file that tells Earmark how to search a site and read its results. Each result needs a magnet, an infoHash, a torrentUrl, or a detailUrl plus a "detail" block.</Text>
          <Text style={T.body}>Templates: {'{field}'} reads a value (dot paths work), filters chain with | such as urlencode, clean, bytes, first, abs, regex:…, and {'{a||b}'} falls back to b. HTML sources use "itemRegex"; capture groups become {'{1}'}, {'{2}'} or named groups.</Text>
          <View style={{ backgroundColor: C.bg, borderRadius: R.md, padding: 12, borderWidth: 1, borderColor: C.line }}>
            <Text selectable style={{ color: C.sub, fontFamily: 'monospace', fontSize: 11 }}>{EXAMPLE_SCRAPER}</Text>
          </View>
          <Text style={T.small}>Full reference: SCRAPERS.md in the project.</Text>
        </ScrollView>
      </Sheet>

      <AiKeySheet visible={aiOpen} onClose={() => setAiOpen(false)} provider={aiProvider} onProvider={setAiProvider} />
      <HardcoverSheet visible={hcOpen} onClose={() => setHcOpen(false)} user={hcUser} onUser={setHcUser} />
      <ReadingHistorySheet visible={historyOpen} onClose={() => setHistoryOpen(false)}
        library={library} existing={readElsewhere} onReadElsewhere={onReadElsewhere} onImported={onImported} />
      <SyncSheet visible={syncOpen} onClose={() => setSyncOpen(false)} status={syncStatus} />
      <ReadalongServerSheet visible={raOpen} onClose={() => setRaOpen(false)} onChanged={reloadRaServer} />
      <EbookSearchSheet visible={ebookOpen} onClose={() => setEbookOpen(false)} onChanged={reloadEbookUrl} />
      <NarratorsSheet visible={narratorsOpen} onClose={() => setNarratorsOpen(false)} narrators={narrators} onNarrators={onNarrators} />
      <ImportBackupSheet visible={!!importData} file={importData} busy={backupBusy} onClose={() => setImportData(null)} onMerge={() => applyImport('merge')} onReplace={() => applyImport('replace')} onAdd={addSetup} />
    </View>
  );
}

function AiKeySheet({ visible, onClose, provider, onProvider }: { visible: boolean; onClose: () => void; provider: AiProvider | null; onProvider: (p: AiProvider | null) => void }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const connect = async () => {
    setBusy(true);
    try {
      const clean = cleanKey(key);
      const { provider: p, model } = await pickModel(clean); // also proves the key works
      await setAiKey(clean);
      onProvider(p); setKey(''); toast(`${providerName(p)} connected (${model})`); onClose();
    } catch (e: any) { toast(e.message ?? 'Could not connect', 'err'); }
    finally { setBusy(false); }
  };
  return (
    <Sheet visible={visible} onClose={onClose} title="Personal picks">
      <View style={{ paddingHorizontal: 20, gap: 12 }}>
        {provider ? (
          <>
            <Text style={T.body}>Surprise me uses <Text style={{ color: C.text, fontWeight: '700' }}>{providerName(provider)}</Text> to choose a book from the charts based on what you’ve listened to. Each time, the titles, authors and progress of the books in your library and your Want to listen list are sent to {providerName(provider)}.</Text>
            <Button kind="danger" icon="unlink-outline" label="Remove key" onPress={async () => { await setAiKey(null); onProvider(null); toast('Key removed. Surprise me is random again.'); onClose(); }} />
          </>
        ) : (
          <>
            <Text style={T.body}>Paste an API key from Gemini, Groq or Grok and Surprise me will choose books based on your listening history instead of at random. The key is stored only on this device. Using it sends the titles, authors and progress of your library to that service.</Text>
            <Input value={key} onChangeText={setKey} placeholder="Gemini, Groq (gsk_…) or Grok (xai-…) key" placeholderTextColor={C.faint} autoCapitalize="none" autoCorrect={false} secureTextEntry accessibilityLabel="AI API key"
              style={{ backgroundColor: C.bg, color: C.text, borderRadius: R.md, padding: 14, borderWidth: 1, borderColor: C.line }} />
            <Button label="Connect" icon="link" onPress={connect} loading={busy} disabled={!key.trim()} />
            <Text onPress={() => Linking.openURL('https://aistudio.google.com/apikey')} style={[T.small, { textAlign: 'center', color: C.accent }]}>Get a free Gemini key</Text>
            <Text onPress={() => Linking.openURL('https://console.groq.com/keys')} style={[T.small, { textAlign: 'center', color: C.accent }]}>Get a free Groq key</Text>
          </>
        )}
      </View>
    </Sheet>
  );
}

function HardcoverSheet({ visible, onClose, user, onUser }: { visible: boolean; onClose: () => void; user: HcUser | null; onUser: (u: HcUser | null) => void }) {
  const [tok, setTok] = useState('');
  const [busy, setBusy] = useState(false);
  const connect = async () => {
    setBusy(true);
    try {
      const clean = tok.trim().replace(/^bearer\s+/i, '');
      const me = await fetchMe(clean);
      await setHcToken(clean);
      onUser(me); setTok(''); toast(`Connected as @${me.username}`); onClose();
    } catch (e: any) { toast(e.message ?? 'Could not connect', 'err'); }
    finally { setBusy(false); }
  };
  return (
    <Sheet visible={visible} onClose={onClose} title="Hardcover">
      <View style={{ paddingHorizontal: 20, gap: 12 }}>
        {user ? (
          <>
            <Text style={T.body}>Connected as <Text style={{ color: C.text, fontWeight: '700' }}>@{user.username}</Text>. Link a book from the player to mark it Currently Reading; progress syncs every couple of minutes and the book is marked Read when you finish.</Text>
            <Button kind="danger" icon="unlink-outline" label="Disconnect" onPress={async () => { await setHcToken(null); onUser(null); toast('Hardcover disconnected'); onClose(); }} />
          </>
        ) : (
          <>
            <Text style={T.body}>Paste your API token from hardcover.app → Settings → API. It is stored only on this device.</Text>
            <Input value={tok} onChangeText={setTok} placeholder="Token" placeholderTextColor={C.faint} autoCapitalize="none" autoCorrect={false} secureTextEntry accessibilityLabel="Hardcover API token"
              style={{ backgroundColor: C.bg, color: C.text, borderRadius: R.md, padding: 14, borderWidth: 1, borderColor: C.line }} />
            <Button label="Connect" icon="link" onPress={connect} loading={busy} disabled={!tok.trim()} />
            <Text onPress={() => Linking.openURL('https://hardcover.app/account/api')} style={[T.small, { textAlign: 'center', color: C.accent }]}>Open hardcover.app/account/api</Text>
          </>
        )}
      </View>
    </Sheet>
  );
}

function ReadingHistorySheet({ visible, onClose, library, existing, onReadElsewhere, onImported }: {
  visible: boolean; onClose: () => void;
  library: LibraryBook[]; existing: ReadElsewhere[];
  onReadElsewhere: (list: ReadElsewhere[]) => void; onImported: () => void;
}) {
  const [hasToken, setHasToken] = useState<boolean | null>(null);
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [busy, setBusy] = useState<null | 'hardcover' | 'goodreads' | 'import'>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    setPlan(null); setError(null);
    getHcToken().then((t) => setHasToken(!!t), () => setHasToken(false));
  }, [visible]);

  // Fetches or parses first, then shows a summary; nothing is written until Import.
  const load = async (source: 'hardcover' | 'goodreads') => {
    setError(null); setPlan(null); setBusy(source);
    try {
      const books = source === 'hardcover' ? await fetchHardcoverHistory() : await pickGoodreadsExport();
      if (!books) return; // the picker was cancelled
      const removed = await loadRemovedReadElsewhere();
      setPlan(planReadingImport(books, library, existing, removed));
    } catch (e: any) {
      setError(e?.message ?? 'Could not read your reading history');
    } finally { setBusy(null); }
  };

  const runImport = async () => {
    if (!plan) return;
    setBusy('import');
    try {
      await applyReadingPlan(plan);
      onReadElsewhere(plan.entries);
      onImported();
      toast(`${plan.added} added, ${plan.updated} updated, ${plan.matchedFinished} already in your library, ${plan.skippedUnfinished} skipped`);
      onClose();
    } catch (e: any) {
      setError(e?.message ?? 'Could not import your reading history');
    } finally { setBusy(null); }
  };

  return (
    <Sheet visible={visible} onClose={onClose} title="Import reading history">
      <View style={{ paddingHorizontal: 20, gap: 12 }}>
        {plan ? (
          <>
            <Text style={T.body}>
              {plan.found} read book{plan.found === 1 ? '' : 's'} found. {plan.matchedFinished} match finished books in your library
              {plan.gainRating || plan.gainDate ? ` (${plan.gainRating} gain a rating, ${plan.gainDate} a finish date)` : ''}.
              {' '}{plan.skippedUnfinished} match unfinished books and will be skipped. {plan.added} will be added to the Finished shelf, {plan.updated} already there will be updated.
            </Text>
            <Button label="Import" icon="download-outline" onPress={runImport} loading={busy === 'import'} disabled={busy !== null && busy !== 'import'} />
            <Button kind="ghost" label="Cancel" onPress={onClose} />
          </>
        ) : (
          <>
            <Text style={T.body}>Finished these books on another service? Import them and they join the Finished shelf. Nothing is written until you confirm.</Text>
            <Button label="From Hardcover" icon="bookmarks-outline" onPress={() => load('hardcover')} loading={busy === 'hardcover'} disabled={hasToken !== true || busy !== null} />
            {hasToken === false ? <Text style={T.small}>Connect Hardcover above first.</Text> : null}
            {!isTV && (
              <>
                <Button kind="ghost" label="From a Goodreads export" icon="document-attach-outline" onPress={() => load('goodreads')} loading={busy === 'goodreads'} disabled={busy !== null} />
                <Text style={T.small}>Goodreads: Account → My Books → Import/Export → Export Library.</Text>
              </>
            )}
          </>
        )}
        {error ? <Text style={[T.small, { color: C.danger }]}>{error}</Text> : null}
      </View>
    </Sheet>
  );
}

function SyncSheet({ visible, onClose, status }: { visible: boolean; onClose: () => void; status: SyncStatus }) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!visible) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(id);
  }, [visible]);
  const connect = async () => {
    setBusy(true);
    try { await connectSync(token); setToken(''); toast('Sync connected'); onClose(); }
    catch (e: any) { toast(e.message ?? 'Could not connect', 'err'); }
    finally { setBusy(false); }
  };
  return (
    <Sheet visible={visible} onClose={onClose} title="Sync">
      <View style={{ paddingHorizontal: 20, gap: 12 }}>
        {status.connected ? (
          <>
            <Text style={T.body}>
              {status.versionTooNew ? 'This sync was written by a newer version of Earmark. Update the app.'
                : status.error ? status.error
                : status.lastSyncAt ? `Synced ${relativeTime(status.lastSyncAt, now)}. Progress, covers, hidden books and settings are up to date.`
                : 'Connected. Waiting for the first sync.'}
            </Text>
            <Button icon="sync-outline" label={status.busy ? 'Syncing…' : 'Sync now'} loading={status.busy} onPress={() => { void syncNow(); }} />
            <Button kind="danger" icon="unlink-outline" label="Disconnect" onPress={async () => { await disconnectSync(); toast('Sync disconnected'); onClose(); }} />
          </>
        ) : (
          <>
            <Text style={T.body}>Sync listening progress, covers, hidden books, your Want to listen list and playback settings between this device and your other one.</Text>
            <Input value={token} onChangeText={setToken} placeholder="GitHub token (gist scope)" placeholderTextColor={C.faint} autoCapitalize="none" autoCorrect={false} secureTextEntry accessibilityLabel="GitHub token"
              style={{ backgroundColor: C.bg, color: C.text, borderRadius: R.md, padding: 14, borderWidth: 1, borderColor: C.line }} />
            <Button icon="link" label="Connect" onPress={connect} loading={busy} disabled={!token.trim()} />
            <Text style={T.small}>Create a token at github.com/settings/tokens with only the “gist” scope, then use the same token on your other device.</Text>
          </>
        )}
      </View>
    </Sheet>
  );
}

function ReadalongServerSheet({ visible, onClose, onChanged }: {
  visible: boolean; onClose: () => void; onChanged: () => void;
}) {
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [hasToken, setHasToken] = useState(false);
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [result, setResult] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    if (!visible) return;
    let alive = true;
    (async () => {
      const [u, t] = await Promise.all([loadReadalongServerUrl(), getReadalongServerToken()]);
      if (!alive) return;
      setUrl(u); setHasToken(!!t); setToken(''); setResult(null);
    })();
    return () => { alive = false; };
  }, [visible]);

  const save = async () => {
    if (!url.trim()) { setResult({ kind: 'err', text: 'Enter the server URL first.' }); return; }
    setBusy('save');
    try {
      await saveReadalongServerUrl(normalizeServerUrl(url));
      if (token.trim()) { await setReadalongServerToken(token); setHasToken(true); setToken(''); }
      setResult({ kind: 'ok', text: 'Saved.' });
      onChanged();
    } catch (e: any) { setResult({ kind: 'err', text: e?.message ?? 'Could not save.' }); }
    finally { setBusy(null); }
  };

  const test = async () => {
    const base = normalizeServerUrl(url);
    const tok = token.trim() || (hasToken ? (await getReadalongServerToken()) ?? '' : '');
    if (!base || !tok) { setResult({ kind: 'err', text: 'Enter both the URL and the token to test.' }); return; }
    setBusy('test');
    setResult(null);
    try {
      const probe = await testServer({ url: base, token: tok });
      setResult(probe === 'reachable' ? { kind: 'ok', text: 'Reachable — the server accepted the token.' }
        : probe === 'token-rejected' ? { kind: 'err', text: 'Reachable, but the server rejected the token.' }
        : { kind: 'err', text: 'Could not reach the server.' });
    } catch (e: any) { setResult({ kind: 'err', text: e?.message ?? 'Could not reach the server.' }); }
    finally { setBusy(null); }
  };

  const remove = async () => {
    if (!(await confirmAction('Remove read-along server?', 'The app will stop building read-alongs on the server.', 'Remove'))) return;
    await clearReadalongServer();
    setUrl(''); setToken(''); setHasToken(false); setResult(null);
    onChanged(); toast('Read-along server removed');
  };

  return (
    <Sheet visible={visible} onClose={onClose} title="Read-along server">
      <View style={{ paddingHorizontal: 20, gap: 12 }}>
        <Text style={T.body}>Build read-alongs on an always-on computer instead of this device. The URL and token come from the server’s setup; nothing else changes while it is unset.</Text>
        <Input value={url} onChangeText={setUrl} placeholder="https://readalong.example.org/readalong" placeholderTextColor={C.faint} autoCapitalize="none" autoCorrect={false} keyboardType="url" accessibilityLabel="Read-along server URL"
          style={{ backgroundColor: C.bg, color: C.text, borderRadius: R.md, padding: 14, borderWidth: 1, borderColor: C.line }} />
        <Input value={token} onChangeText={setToken} placeholder={hasToken ? 'Token saved — type to replace' : 'API token'} placeholderTextColor={C.faint} autoCapitalize="none" autoCorrect={false} secureTextEntry accessibilityLabel="Read-along server token"
          style={{ backgroundColor: C.bg, color: C.text, borderRadius: R.md, padding: 14, borderWidth: 1, borderColor: C.line }} />
        {result ? <Text style={[T.small, { color: result.kind === 'ok' ? C.good : C.danger }]}>{result.text}</Text> : null}
        <Button label="Save" icon="save-outline" onPress={save} loading={busy === 'save'} disabled={!url.trim()} />
        <Button kind="ghost" label="Test" icon="pulse-outline" onPress={test} loading={busy === 'test'} disabled={!url.trim()} />
        {hasToken ? <Button kind="danger" icon="trash-outline" label="Remove" onPress={remove} /> : null}
      </View>
    </Sheet>
  );
}

function EbookSearchSheet({ visible, onClose, onChanged }: {
  visible: boolean; onClose: () => void; onChanged: () => void;
}) {
  const [url, setUrl] = useState('');
  const [result, setResult] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    if (!visible) return;
    let alive = true;
    loadEbookSearchUrl().then((u) => { if (alive) { setUrl(u); setResult(null); } }, () => {});
    return () => { alive = false; };
  }, [visible]);

  const save = async () => {
    const trimmed = url.trim();
    if (trimmed && !isHttpUrl(trimmed)) { setResult({ kind: 'err', text: 'Enter an http(s) address, e.g. https://…/ebook/search.' }); return; }
    await saveEbookSearchUrl(trimmed);
    setResult({ kind: 'ok', text: trimmed ? 'Saved.' : 'Cleared.' });
    onChanged();
  };

  const clear = async () => {
    await saveEbookSearchUrl('');
    setUrl(''); setResult({ kind: 'ok', text: 'Cleared.' });
    onChanged();
  };

  return (
    <Sheet visible={visible} onClose={onClose} title="EPUB search address">
      <View style={{ paddingHorizontal: 20, gap: 12 }}>
        <Text style={T.body}>Where Earmark looks for a book’s EPUB when building a read-along. It is stored only on this device; leave it empty to turn EPUB search off.</Text>
        <Input value={url} onChangeText={setUrl} placeholder="https://…/ebook/search" placeholderTextColor={C.faint} autoCapitalize="none" autoCorrect={false} keyboardType="url" accessibilityLabel="EPUB search address"
          style={{ backgroundColor: C.bg, color: C.text, borderRadius: R.md, padding: 14, borderWidth: 1, borderColor: C.line }} />
        {result ? <Text style={[T.small, { color: result.kind === 'ok' ? C.good : C.danger }]}>{result.text}</Text> : null}
        <Button label="Save" icon="save-outline" onPress={save} />
        {url.trim() ? <Button kind="danger" icon="trash-outline" label="Clear" onPress={clear} /> : null}
      </View>
    </Sheet>
  );
}

function NarratorsSheet({ visible, onClose, narrators, onNarrators }: {
  visible: boolean; onClose: () => void; narrators: string[]; onNarrators: (list: string[]) => void;
}) {
  return (
    <Sheet visible={visible} onClose={onClose} title="Narrators you follow">
      <View style={{ paddingHorizontal: 20, gap: 12 }}>
        {narrators.length ? (
          <View style={{ backgroundColor: C.bg, borderRadius: R.md, borderWidth: 1, borderColor: C.line, overflow: 'hidden' }}>
            {narrators.map((n, i) => (
              <Row key={n} last={i === narrators.length - 1} title={n}
                right={<IconButton name="close" label={`Stop following ${n}`} size={18} color={C.danger}
                  onPress={() => { onNarrators(toggleNarrator(n, narrators)); toast(`Stopped following ${n}`); }} />} />
            ))}
          </View>
        ) : (
          <Text style={T.body}>You don’t follow any narrators yet. Open a search result in Discover and tap the heart beside a narrator’s name to follow them.</Text>
        )}
      </View>
    </Sheet>
  );
}

function ImportBackupSheet({ visible, file, busy, onClose, onMerge, onReplace, onAdd }: {
  visible: boolean; file: ImportFile | null; busy: null | 'export' | 'setup' | 'merge' | 'replace';
  onClose: () => void; onMerge: () => void; onReplace: () => void; onAdd: () => void;
}) {
  const info = file?.kind === 'backup' ? backupSummary(file) : null;
  const setup = file?.kind === 'setup' ? setupSummary(file) : null;
  return (
    <Sheet visible={visible} onClose={onClose} title="Import data">
      <View style={{ paddingHorizontal: 20, gap: 12 }}>
        {info ? (
          <>
            <Text style={T.body}>
              Exported {info.exportedAt ? new Date(info.exportedAt).toLocaleString() : 'at an unknown date'}{info.appVersion ? ` by Earmark ${info.appVersion}` : ''}.
            </Text>
            <Text style={T.body}>
              {info.withProgress} books with progress · {info.finished} finished · {info.ratings} ratings · {info.wishlist} want to listen · {info.readalongs} read-alongs · {info.readElsewhere} read elsewhere · {info.sources} sources
            </Text>
            <Button label="Merge" icon="git-merge-outline" onPress={onMerge} loading={busy === 'merge'} disabled={busy !== null && busy !== 'merge'} />
            <Button kind="ghost" label="Replace" icon="swap-horizontal-outline" onPress={onReplace} loading={busy === 'replace'} disabled={busy !== null && busy !== 'replace'} />
            <Text style={T.small}>Merge keeps what is on this device and takes newer records from the file. Replace makes the file the only truth on this device. Keys and tokens are not included.</Text>
          </>
        ) : setup ? (
          <>
            <Text style={T.body}>
              A setup file with {setup.sources} source{setup.sources === 1 ? '' : 's'}{setup.search ? ' and an EPUB search address' : ''}.
            </Text>
            <Button label="Add to this device" icon="add-circle-outline" onPress={onAdd} loading={busy === 'setup'} />
            <Text style={T.small}>Adds sources that are not already here. Your existing sources, the disabled list and your search address stay as they are. Keys and tokens are not included.</Text>
          </>
        ) : null}
      </View>
    </Sheet>
  );
}

function relativeTime(ms: number, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <View style={{ marginBottom: 22 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <Text style={T.label}>{title}</Text>{action}
      </View>
      <View style={{ backgroundColor: C.surface, borderRadius: R.lg, borderWidth: 1, borderColor: C.line, overflow: 'hidden' }}>{children}</View>
    </View>
  );
}

function Row({ left, title, sub, right, onPress, last }: { left?: React.ReactNode; title: string; sub?: string; right?: React.ReactNode; onPress?: () => void; last?: boolean }) {
  return (
    <Tap onPress={onPress} scaleTo={0.99} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderBottomWidth: last ? 0 : 1, borderBottomColor: C.line }}>
      {left}
      <View style={{ flex: 1 }}>
        <Text style={T.title}>{title}</Text>
        {sub ? <Text style={[T.small, { marginTop: 2 }]}>{sub}</Text> : null}
      </View>
      {right}
    </Tap>
  );
}

function Badge({ icon, color }: { icon: IconName; color: string }) {
  return (
    <View style={{ width: 38, height: 38, borderRadius: 10, backgroundColor: color + '26', alignItems: 'center', justifyContent: 'center' }}>
      <Ionicons name={icon} size={19} color={color} />
    </View>
  );
}

/** A Switch wrapped so a TV remote's focus shows the accent ring; a phone never sees it. */
function FocusSwitch(props: React.ComponentProps<typeof Switch>) {
  const [focused, setFocused] = useState(false);
  return (
    <View style={isTV && focused ? tvFocusRing : null}>
      <Switch {...props} onFocus={(e) => { setFocused(true); props.onFocus?.(e); }} onBlur={(e) => { setFocused(false); props.onBlur?.(e); }} />
    </View>
  );
}
