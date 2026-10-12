// The read-along creation sheet: pick an EPUB, confirm it, and watch the build. On the desktop
// with the local GPU tool it builds locally (job.ts tracks that job); otherwise, when a read-along
// server is configured, it uploads the paragraphs and polls the server. Both paths share the same
// search, scope choice and TorBox confirmation.
//
// The local job lives in src/readalong/job.ts so its progress survives closing the sheet. The
// server job is tracked here and remembered in storage (background.ts reconciles it across app
// launches), so reopening the sheet shows its progress.

import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, FlatList, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { C, R, T, prettyName } from '../theme';
import { Bar, Button, Sheet, Tap, confirmAction, toast, Input } from './ui';
import { readalongBridge, type ReadalongStatus } from '../readalong/desktop';
import { chapterTitle, type TBTorrent, type TBFile } from '../torbox';
import type { BookMeta } from '../storage';
import { loadReadalong, deleteReadalong, loadPendingJobs, savePendingJobs, saveReadalong, loadEbookSearchUrl } from '../storage';
import type { ReadalongRecord } from '../readalong/anchors';
import type { EbookCandidate } from '../readalong/ebookSearch';
import { findEpubCandidates, searchEpubCandidates, searchTerms, runReadalong, cancelBuild, submitServerBuild } from '../readalong/create';
import { defaultScope } from '../readalong/scope';
import { getJob, subscribeJob, jobActive, resetJob, type ReadalongJobState } from '../readalong/job';
import {
  serverConfig, getJob as fetchServerJob, cancelJob, jobRunning, chooseBuildPath,
  type ServerConfig, type ServerJob,
} from '../readalong/server';
import { clearPending, pendingFor, pendingOutcome } from '../readalong/pending';
import { pendingError, clearPendingError } from '../readalong/background';

/** Subscribes to the shared build job (in ReadalongSheet.tsx so job.ts stays React-free). */
export function useReadalongJob(): ReadalongJobState {
  return useSyncExternalStore(subscribeJob, getJob, getJob);
}

const MB = 1024 * 1024;
const mb = (n: number) => Math.round(n / MB);
const downloadLabel = (bytes: number, total: number) =>
  total > 0 ? `Downloading audio… ${mb(bytes)} / ${mb(total)} MB` : `Downloading audio… ${mb(bytes)} MB`;

const SERVER_HINT = 'Building on the server, about 20 minutes. You can close this.';

export function ReadalongSheet({ visible, onClose, book, meta, chapters, index }: {
  visible: boolean;
  onClose: () => void;
  book: TBTorrent;
  meta: BookMeta;
  chapters: TBFile[];
  index: number;
}) {
  const bridge = readalongBridge();
  const jobState = useReadalongJob();
  const title = (meta.title ?? '').trim() || prettyName(book.name);
  const currentFile = chapters[index];

  const [status, setStatus] = useState<ReadalongStatus | null>(null);
  const [record, setRecord] = useState<ReadalongRecord | null>(null);
  const [server, setServer] = useState<ServerConfig | null | undefined>(undefined);
  const [searchUrl, setSearchUrl] = useState<string | undefined>(undefined);
  const [serverJob, setServerJob] = useState<ServerJob | null>(null);
  const [serverError, setServerError] = useState('');
  const [view, setView] = useState<'home' | 'browse' | 'progress'>('home');
  const [scope, setScope] = useState<'all' | 'current'>('all');
  const [query, setQuery] = useState(title);
  const [candidates, setCandidates] = useState<EbookCandidate[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [confirming, setConfirming] = useState<EbookCandidate | null>(null);
  const [lastRun, setLastRun] = useState<EbookCandidate | null>(null);
  const doneRef = useRef(false);

  // The files a build will cover. "Only this file" is for series torrents, where each file is a book.
  const fileIds = scope === 'current' && currentFile ? [currentFile.id] : chapters.map((f) => f.id);

  // Which builder to use: the local tool when it is here, else a configured server, else none.
  const path = chooseBuildPath(!!status?.available, !!server);
  const loading = status === null || server === undefined || searchUrl === undefined;

  useEffect(() => {
    if (!visible) return;
    let alive = true;
    setStatus(null);
    setCandidates(null);
    setConfirming(null);
    setSearchError('');
    setQuery(title);
    setScope(defaultScope(chapters, book.name));
    setServer(undefined);
    setSearchUrl(undefined);
    setServerJob(null);
    setServerError('');
    setView(jobActive(getJob()) ? 'progress' : 'home');
    loadReadalong(book.hash).then((r) => { if (alive) setRecord(r); }, () => {});

    if (bridge) {
      bridge.status()
        .then((s) => { if (alive) setStatus(s); })
        .catch((e: any) => { if (alive) setStatus({ available: false, reason: e?.message ?? 'Could not check the tool', python: '', script: '' }); });
    } else {
      setStatus({ available: false, reason: '', python: '', script: '' });
    }

    serverConfig().then((c) => { if (alive) setServer(c); }, () => { if (alive) setServer(null); });
    loadEbookSearchUrl().then((u) => { if (alive) setSearchUrl(u); }, () => { if (alive) setSearchUrl(''); });

    // A failed server build leaves its message here; show it once, then let the user rebuild.
    const lastError = pendingError(book.hash);
    if (lastError) { setServerError(lastError); clearPendingError(book.hash); }

    // A remembered job for this book reopens on its progress.
    (async () => {
      const pending = pendingFor(await loadPendingJobs(), book.hash);
      if (!pending || !alive) return;
      try {
        const j = await fetchServerJob(pending.jobId);
        if (!alive) return;
        setServerJob(j);
        setView('progress');
      } catch { /* offline for now; the next check will find it */ }
    })();

    return () => { alive = false; };
  }, [visible, book.hash]);

  // A finished local job refreshes the saved record and announces itself once.
  useEffect(() => {
    if (jobState.status !== 'done') { doneRef.current = false; return; }
    loadReadalong(book.hash).then(setRecord, () => {});
    if (!doneRef.current) {
      doneRef.current = true;
      toast(`Read-along ready: ${jobState.matched} of ${jobState.total} clips matched`);
    }
  }, [jobState, book.hash]);

  // Fold a finished server job into local storage: save the record, clear the pending entry, toast.
  const finishServerJob = useCallback(async (job: ServerJob) => {
    const outcome = pendingOutcome(job);
    if (outcome.kind === 'done') {
      await saveReadalong(book.hash, outcome.record);
      await savePendingJobs(clearPending(await loadPendingJobs(), book.hash));
      setRecord(outcome.record);
      toast(`Read-along ready: ${job.matched} of ${job.total} clips matched`);
    } else if (outcome.kind === 'failed') {
      await savePendingJobs(clearPending(await loadPendingJobs(), book.hash));
      setServerError(outcome.message);
    } else if (outcome.kind === 'cancelled') {
      await savePendingJobs(clearPending(await loadPendingJobs(), book.hash));
      setServerError('');
    }
  }, [book.hash]);

  // Poll the server job every 5 s while the sheet is open and the job is still running.
  useEffect(() => {
    if (!visible || !serverJob || !jobRunning(serverJob.status)) return;
    let alive = true;
    const id = setInterval(async () => {
      try {
        const j = await fetchServerJob(serverJob.id);
        if (!alive) return;
        setServerJob(j);
        await finishServerJob(j);
      } catch { /* keep the last state and try again next tick */ }
    }, 5000);
    return () => { alive = false; clearInterval(id); };
  }, [visible, serverJob?.id, serverJob?.status, finishServerJob]);

  const runSearch = useCallback(async (next: 'all' | 'current', text?: string) => {
    setConfirming(null);
    setSearchError('');
    setSearching(true);
    setCandidates(null);
    const file = next === 'current' ? currentFile : undefined;
    try {
      if (text != null) {
        setCandidates(await searchEpubCandidates(text, searchTerms(book, meta, file).author));
      } else {
        // Show the cleaned title the search really uses, so the box can be edited from there.
        setQuery(searchTerms(book, meta, file).title);
        setCandidates(await findEpubCandidates(book, meta, file));
      }
    } catch (e: any) {
      setSearchError(e?.message ?? 'Could not search for an EPUB.');
      setCandidates([]);
    } finally {
      setSearching(false);
    }
  }, [book, meta, currentFile]);

  const browse = useCallback(async () => {
    setView('browse');
    await runSearch(scope);
  }, [runSearch, scope]);

  const research = useCallback(() => runSearch(scope, query), [runSearch, scope, query]);

  // The search terms depend on the scope, so switching it while browsing searches again.
  const pickScope = useCallback((next: 'all' | 'current') => {
    if (next === scope) return;
    setScope(next);
    if (view === 'browse') runSearch(next);
  }, [scope, view, runSearch]);

  const start = useCallback(async (candidate: EbookCandidate) => {
    setConfirming(null);
    setLastRun(candidate);
    setView('progress');
    setServerError('');
    try {
      if (path === 'server') {
        const id = await submitServerBuild(book, fileIds, candidate);
        resetJob();
        setServerJob({
          id, status: 'queued', position: 0, done: 0, total: 0, matched: 0,
          bytes: 0, bytesTotal: 0, error: null, record: null, createdAt: null, updatedAt: null,
        });
      } else {
        await runReadalong(book, fileIds, candidate);
      }
    } catch {
      // The local path records the failure in the shared job; the server path sets its own message.
      if (path === 'server') setServerJob(null);
    }
  }, [book, fileIds, path]);

  const cancelServer = useCallback(async () => {
    if (serverJob && jobRunning(serverJob.status)) {
      try { await cancelJob(serverJob.id); } catch { /* it may already be gone */ }
      await savePendingJobs(clearPending(await loadPendingJobs(), book.hash));
      setServerJob({ ...serverJob, status: 'cancelled' });
      toast('Cancelled');
    } else {
      // Nothing is on the server yet: the app is still waiting for TorBox or reading the EPUB.
      await cancelBuild();
      resetJob();
      setView('home');
    }
  }, [serverJob, book.hash]);

  const remove = useCallback(async () => {
    const ok = await confirmAction('Remove read-along?', 'This deletes the saved anchors for this book on every synced device.', 'Remove');
    if (!ok) return;
    await deleteReadalong(book.hash);
    setRecord(null);
    toast('Read-along removed');
  }, [book.hash]);

  // Retry a failed build. If it was picked up from a previous session there is no candidate to
  // re-submit, so fall back to the home view instead.
  const retry = useCallback(() => {
    if (lastRun) void start(lastRun);
    else { setServerJob(null); setView('home'); }
  }, [lastRun, start]);

  return (
    <Sheet visible={visible} onClose={onClose} title="Read-along">
      {serverJob ? (
        <ProgressView state={serverState(serverJob)} hint={SERVER_HINT} onCancel={cancelServer}
          onRetry={retry} onClose={onClose} />
      ) : loading ? (
        <View style={{ padding: 32, alignItems: 'center', gap: 12 }}>
          <ActivityIndicator color={C.accent} />
          <Text style={T.body}>Checking what can build this…</Text>
        </View>
      ) : path === 'none' ? (
        bridge ? (
          <Notice icon="construct-outline" title="The read-along tool isn’t set up"
            body={`${status?.reason ?? 'Some pieces are missing.'} Install them, then reopen this sheet.`}>
            <View style={{ backgroundColor: C.bg, borderRadius: R.md, borderWidth: 1, borderColor: C.line, padding: 12, marginTop: 4 }}>
              <Text selectable style={{ color: C.text, fontFamily: 'monospace', fontSize: 13 }}>Run tools/readalong/setup.sh</Text>
            </View>
          </Notice>
        ) : (
          <Notice icon="desktop-outline" title="Read-along is a desktop feature"
            body="The read-along tool runs on your computer, or add a read-along server in Settings. Open this book in the Earmark desktop app to build it." />
        )
      ) : view === 'progress' || jobActive(jobState) ? (
        <ProgressView state={jobState}
          hint={path === 'server' ? 'Uploading to the read-along server…' : undefined}
          onCancel={path === 'server' ? cancelServer : cancelBuild}
          onRetry={retry} onClose={onClose} />
      ) : view === 'browse' && !searchUrl ? (
        <Notice icon="book-outline" title="No EPUB search address"
          body="Add one under Settings → Read-along to search for the book’s EPUB." />
      ) : view === 'browse' ? (
        <View style={{ paddingHorizontal: 20 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: C.bg, borderRadius: R.md, borderWidth: 1, borderColor: C.line, paddingHorizontal: 12, height: 48 }}>
            <Ionicons name="search" size={18} color={C.faint} />
            <Input value={query} onChangeText={setQuery} onSubmitEditing={research} returnKeyType="search" accessibilityLabel="Book title"
              placeholder="Book title" placeholderTextColor={C.faint}
              style={{ flex: 1, color: C.text, marginLeft: 8 }} />
            {searching ? <ActivityIndicator color={C.accent} /> : null}
          </View>
          {chapters.length > 1 ? (
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
              <Seg active={scope === 'all'} label={`All ${chapters.length}`} onPress={() => pickScope('all')} />
              <Seg active={scope === 'current'} label="This file" onPress={() => pickScope('current')} />
            </View>
          ) : null}
          <Text numberOfLines={1} style={[T.small, { marginTop: 8 }]}>
            {scope === 'current' && currentFile ? `Only “${chapterTitle(currentFile)}”` : `All ${chapters.length} files`}
          </Text>

          {confirming ? (
            <Confirm candidate={confirming} count={fileIds.length} onCancel={() => setConfirming(null)} onConfirm={() => start(confirming)} />
          ) : searching ? (
            <View style={{ padding: 32, alignItems: 'center', gap: 12 }}>
              <ActivityIndicator color={C.accent} />
              <Text style={T.body}>Searching for the EPUB…</Text>
            </View>
          ) : searchError ? (
            <View style={{ padding: 24, alignItems: 'center', gap: 12 }}>
              <Text style={[T.body, { textAlign: 'center' }]}>{searchError}</Text>
              <Button kind="ghost" icon="refresh" label="Try again" onPress={research} />
            </View>
          ) : candidates && candidates.length === 0 ? (
            <Text style={[T.body, { textAlign: 'center', padding: 32 }]}>No EPUB results. Try a different title.</Text>
          ) : (
            <FlatList
              data={candidates ?? []}
              keyExtractor={(c, i) => `${c.infoHash ?? c.magnet ?? c.title}:${i}`}
              style={{ maxHeight: 380, marginTop: 8 }}
              keyboardShouldPersistTaps="handled"
              renderItem={({ item }) => <CandidateRow candidate={item} onPress={() => setConfirming(item)} />}
            />
          )}

          <View style={{ marginTop: 12 }}>
            <Button kind="ghost" icon="chevron-back" label="Back" onPress={() => { setConfirming(null); setView('home'); }} />
          </View>
        </View>
      ) : (
        <View style={{ paddingHorizontal: 20, gap: 14 }}>
          {serverError ? (
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', padding: 12, borderRadius: R.md, backgroundColor: 'rgba(255,107,107,0.12)' }}>
              <Ionicons name="alert-circle" size={18} color={C.danger} />
              <Text style={{ color: C.text, flex: 1, fontSize: 13 }}>{serverError}</Text>
            </View>
          ) : null}

          {record ? (
            <View style={{ backgroundColor: C.elevated, borderRadius: R.md, borderWidth: 1, borderColor: C.line, padding: 14, gap: 4 }}>
              <Text numberOfLines={1} style={T.title}>{record.epub.title || 'EPUB'}</Text>
              <Text style={T.small}>
                {anchorCount(record)} anchor{anchorCount(record) === 1 ? '' : 's'} · created {new Date(record.created).toLocaleDateString()}
              </Text>
            </View>
          ) : null}

          {chapters.length > 1 ? (
            <View style={{ gap: 8 }}>
              <Text style={T.label}>Which files?</Text>
              <View style={{ gap: 8 }}>
                <Choice selected={scope === 'all'} onPress={() => pickScope('all')}
                  title={`All ${chapters.length} files`} sub="Build one read-along across the whole torrent" />
                <Choice selected={scope === 'current'} onPress={() => pickScope('current')}
                  title={`Only this file (${currentFile ? chapterTitle(currentFile) : 'current chapter'})`}
                  sub="Better for series torrents, where each file is a whole book" />
              </View>
            </View>
          ) : null}

          {searchUrl ? (
            <Button icon="book-outline" label={record ? 'Rebuild read-along' : 'Build read-along'} onPress={browse} />
          ) : (
            <Notice icon="book-outline" title="No EPUB search address"
              body="Add one under Settings → Read-along to search for the book’s EPUB." />
          )}
          {record ? <Button kind="danger" icon="trash-outline" label="Remove" onPress={remove} /> : null}
          <Text style={[T.small, { textAlign: 'center', paddingBottom: 4 }]}>
            {path === 'server'
              ? 'Searches your EPUB source for the book, then builds it on your read-along server. Nothing is added to TorBox until you confirm.'
              : 'Searches your EPUB source for the book. Nothing is added to TorBox until you confirm.'}
          </Text>
        </View>
      )}
    </Sheet>
  );
}

function anchorCount(record: ReadalongRecord): number {
  return record.files.reduce((n, f) => n + f.anchors.length, 0);
}

/** Map a server job to the sheet's progress state vocabulary. */
function serverState(job: ServerJob): ReadalongJobState {
  switch (job.status) {
    case 'queued':
    case 'running':
      return { status: 'preparing', message: job.position > 1 ? `Queued on the server (position ${job.position})…` : 'Queued on the server…' };
    case 'downloading':
      return { status: 'downloading', bytes: job.bytes, total: job.bytesTotal };
    case 'building':
      return { status: 'building', done: job.done, total: job.total };
    case 'done':
      return { status: 'done', matched: job.matched, total: job.total };
    case 'failed':
      return { status: 'error', message: job.error || 'The read-along build failed on the server.' };
    case 'cancelled':
      return { status: 'cancelled' };
  }
}

function Choice({ title, sub, selected, onPress }: { title: string; sub: string; selected: boolean; onPress: () => void }) {
  return (
    <Tap onPress={onPress} haptic scaleTo={0.99} style={{
      flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: R.md, borderWidth: 1,
      borderColor: selected ? C.accent : C.line, backgroundColor: selected ? 'rgba(255,181,71,0.1)' : C.elevated,
    }}>
      <Ionicons name={selected ? 'radio-button-on' : 'radio-button-off'} size={20} color={selected ? C.accent : C.faint} />
      <View style={{ flex: 1 }}>
        <Text numberOfLines={1} style={{ color: selected ? C.accent : C.text, fontWeight: '700', fontSize: 14 }}>{title}</Text>
        <Text style={T.small}>{sub}</Text>
      </View>
    </Tap>
  );
}

function Seg({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Tap onPress={onPress} haptic scaleTo={0.97} style={{
      flex: 1, height: 34, borderRadius: R.pill, alignItems: 'center', justifyContent: 'center', borderWidth: 1,
      backgroundColor: active ? C.accent : C.elevated, borderColor: active ? C.accent : C.line,
    }}>
      <Text numberOfLines={1} style={{ color: active ? C.accentInk : C.sub, fontWeight: '700', fontSize: 13 }}>{label}</Text>
    </Tap>
  );
}

function CandidateRow({ candidate, onPress }: { candidate: EbookCandidate; onPress: () => void }) {
  const meta = [candidate.format ? candidate.format.toUpperCase() : '', candidate.sizeLabel, candidate.source].filter(Boolean).join(' · ');
  return (
    <Tap onPress={onPress} scaleTo={0.99} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 }}>
      <View style={{ flex: 1 }}>
        <Text numberOfLines={2} style={T.title}>{candidate.title}</Text>
        {meta ? <Text numberOfLines={1} style={T.small}>{meta}</Text> : null}
        {candidate.seeders != null ? <Text style={T.small}>{candidate.seeders} seeder{candidate.seeders === 1 ? '' : 's'}</Text> : null}
      </View>
      {candidate.cached ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, height: 22, borderRadius: R.pill, backgroundColor: 'rgba(74,222,128,0.15)' }}>
          <Ionicons name="flash" size={11} color={C.good} />
          <Text style={{ color: C.good, fontSize: 11, fontWeight: '700' }}>Cached</Text>
        </View>
      ) : <Ionicons name="chevron-forward" size={18} color={C.faint} />}
    </Tap>
  );
}

function Confirm({ candidate, count, onCancel, onConfirm }: { candidate: EbookCandidate; count: number; onCancel: () => void; onConfirm: () => void }) {
  return (
    <View style={{ marginTop: 12, gap: 12, padding: 14, borderRadius: R.md, borderWidth: 1, borderColor: C.line, backgroundColor: C.elevated }}>
      <Text style={{ color: C.text, fontSize: 15, fontWeight: '600' }}>
        {candidate.inAccount ? `Use “${candidate.title}”, already in your TorBox` : `Add “${candidate.title}” to your TorBox?`}
      </Text>
      <Text style={T.small}>{candidate.inAccount ? 'Nothing new is added to TorBox.' : candidate.cached ? 'TorBox has it cached, so it is ready at once.' : 'TorBox will fetch it, which can take a few minutes.'} {count === 1 ? 'Building one file.' : `Building all ${count} files.`}</Text>
      <Button icon="download-outline" label={candidate.inAccount ? 'Build' : 'Add & build'} onPress={onConfirm} />
      <Button kind="ghost" label="Keep browsing" onPress={onCancel} />
    </View>
  );
}

function ProgressView({ state, hint, onCancel, onRetry, onClose }: {
  state: ReadalongJobState; hint?: string; onCancel: () => void; onRetry: () => void; onClose: () => void;
}) {
  let body: React.ReactNode;
  if (state.status === 'preparing') {
    body = <Text style={[T.body, { textAlign: 'center' }]}>{state.message}</Text>;
  } else if (state.status === 'downloading') {
    body = (
      <>
        <Text style={[T.body, { textAlign: 'center' }]}>{downloadLabel(state.bytes, state.total)}</Text>
        <Bar value={state.total > 0 ? state.bytes / state.total : 0} height={8} />
      </>
    );
  } else if (state.status === 'building') {
    body = (
      <>
        <Text style={[T.body, { textAlign: 'center' }]}>Matching clips… {state.done} / {state.total}</Text>
        <Bar value={state.total > 0 ? state.done / state.total : 0} height={8} />
      </>
    );
  } else if (state.status === 'done') {
    body = (
      <>
        <Ionicons name="checkmark-circle" size={40} color={C.good} />
        <Text style={[T.title, { textAlign: 'center' }]}>Read-along ready: {state.matched} of {state.total} clips matched</Text>
      </>
    );
  } else if (state.status === 'error') {
    body = (
      <>
        <Ionicons name="alert-circle" size={36} color={C.danger} />
        <Text style={[T.body, { textAlign: 'center' }]}>{state.message}</Text>
      </>
    );
  } else if (state.status === 'cancelled') {
    body = <Text style={[T.body, { textAlign: 'center' }]}>Cancelled.</Text>;
  } else {
    body = <Text style={[T.body, { textAlign: 'center' }]}>Starting…</Text>;
  }

  const busy = jobActive(state);
  return (
    <View style={{ paddingHorizontal: 20, paddingVertical: 16, gap: 16 }}>
      <View style={{ alignItems: 'center', gap: 12 }}>
        {busy ? <ActivityIndicator color={C.accent} /> : null}
        {body}
      </View>
      {busy && hint ? <Text style={[T.small, { textAlign: 'center' }]}>{hint}</Text> : null}
      {busy ? <Button kind="ghost" icon="close" label="Cancel" onPress={onCancel} /> : null}
      {state.status === 'error' ? <Button icon="refresh" label="Retry" onPress={onRetry} /> : null}
      {state.status === 'done' || state.status === 'cancelled' ? <Button kind="ghost" icon="checkmark" label="Done" onPress={onClose} /> : null}
    </View>
  );
}

function Notice({ icon, title, body, children }: {
  icon: React.ComponentProps<typeof Ionicons>['name']; title: string; body: string; children?: React.ReactNode;
}) {
  return (
    <View style={{ alignItems: 'center', paddingHorizontal: 24, paddingVertical: 24, gap: 10 }}>
      <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: C.elevated, alignItems: 'center', justifyContent: 'center' }}>
        <Ionicons name={icon} size={30} color={C.accent} />
      </View>
      <Text style={[T.h2, { textAlign: 'center', fontSize: 18 }]}>{title}</Text>
      <Text style={[T.body, { textAlign: 'center', lineHeight: 20 }]}>{body}</Text>
      {children}
    </View>
  );
}
