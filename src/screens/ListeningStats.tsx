// The Listening stats sheet: where the phone, the TV and the desktop add up. It loads the synced
// listening log and renders the pure numbers from src/listening-log.ts. No chart library: the seven
// day bars are plain Views.
import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { C, R, T, prettyName } from '../theme';
import { Sheet, Cover, Empty } from '../components/ui';
import { loadListeningEstimate, loadListeningLog } from '../storage';
import { onSyncApplied } from '../sync';
import { listeningStats, formatListening, formatListeningHours, type ListeningLog, type ListeningEstimate, type StatsBook } from '../listening-log';
import { isTV } from '../layout';
import type { TBTorrent } from '../torbox';
import type { BookMeta } from '../storage';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "Wed" for a `YYYY-MM-DD` local day, or '' when it cannot be read. */
function weekday(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return '';
  return WEEKDAYS[new Date(+m[1], +m[2] - 1, +m[3]).getDay()] ?? '';
}

/** A big headline number with a quieter unit line under it. */
function BigStat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <View style={{ flex: 1, minWidth: 140, backgroundColor: C.elevated, borderRadius: R.lg, padding: 16, gap: 4 }}>
      <Text style={T.label}>{label}</Text>
      <Text numberOfLines={1} adjustsFontSizeToFit style={{ color: C.text, fontSize: 30, fontWeight: '800', letterSpacing: -0.8 }}>{value}</Text>
      {sub ? <Text style={T.small}>{sub}</Text> : null}
    </View>
  );
}

/** One labelled number in the small all-periods row. A period that includes estimate seconds is
 *  rounded to the hour and says so, rather than showing false precision. */
function TinyStat({ label, book, wall, est }: { label: string; book: number; wall: number; est: number }) {
  return (
    <View style={{ flex: 1, minWidth: 100, backgroundColor: C.surface, borderRadius: R.md, borderWidth: 1, borderColor: C.line, padding: 12, gap: 3 }}>
      <Text style={T.label}>{label}</Text>
      <Text numberOfLines={1} style={{ color: C.text, fontSize: 17, fontWeight: '700' }}>{est > 0 ? formatListeningHours(book) : formatListening(book)}</Text>
      <Text style={T.small}>{est > 0 ? `About ${formatListeningHours(est)} estimated` : `${formatListening(wall)} listened`}</Text>
    </View>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <Text style={[T.label, { marginBottom: 10 }]}>{children}</Text>;
}

export function ListeningStatsSheet({ visible, onClose, books, meta }: {
  visible: boolean;
  onClose: () => void;
  books: TBTorrent[];
  meta: Record<string, BookMeta>;
}) {
  const [log, setLog] = useState<ListeningLog | null>(null);
  const [estimate, setEstimate] = useState<ListeningEstimate | null>(null);

  // Reload whenever it opens, and again after a sync (another device's listening may have arrived).
  useEffect(() => {
    if (!visible) return;
    let alive = true;
    const load = () => Promise.all([loadListeningLog(), loadListeningEstimate()]).then(
      ([l, e]) => { if (alive) { setLog(l); setEstimate(e); } },
      () => { if (alive) { setLog({}); setEstimate(null); } },
    );
    load();
    const off = onSyncApplied(load);
    return () => { alive = false; off(); };
  }, [visible]);

  const bookInfo = useMemo(() => {
    const out: Record<string, StatsBook> = {};
    for (const b of books) {
      const m = meta[b.hash?.toLowerCase() ?? ''] ?? {};
      out[String(b.id)] = { title: m.title ?? prettyName(b.name), cover: m.cover, finishedAt: m.finishedAt };
    }
    return out;
  }, [books, meta]);

  const stats = useMemo(() => (log ? listeningStats(log, bookInfo, Date.now(), estimate) : null), [log, bookInfo, estimate]);
  const hasData = (!!log && Object.keys(log).length > 0)
    || (!!estimate && (Object.keys(estimate.books).length > 0 || Object.keys(estimate.days ?? {}).length > 0));

  const barMax = stats ? Math.max(1, ...stats.last7.map((d) => d.book + d.estBook)) : 1;
  const todayDay = stats?.last7[stats.last7.length - 1]?.day;

  return (
    <Sheet visible={visible} onClose={onClose} title="Listening stats">
      <ScrollView focusable={isTV} style={{ paddingHorizontal: 20 }} contentContainerStyle={{ gap: 20, paddingBottom: 8 }} showsVerticalScrollIndicator={false}>
        {!stats || !hasData ? (
          <Empty icon="stats-chart-outline" title="No stats yet" body="Listen to something and your stats will show up here." />
        ) : (
          <>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
              <BigStat label="This week" value={stats.estWeek > 0 ? formatListeningHours(stats.weekBook) : formatListening(stats.weekBook)}
                sub={stats.estWeek > 0 ? `Includes about ${formatListeningHours(stats.estWeek)} estimated from before tracking started` : `${formatListening(stats.weekWall)} of listening`} />
              <BigStat label="This year" value={stats.estYear > 0 ? formatListeningHours(stats.yearBook) : formatListening(stats.yearBook)}
                sub={stats.estYear > 0 ? `Includes about ${formatListeningHours(stats.estYear)} estimated from before tracking started` : `${formatListening(stats.yearWall)} of listening`} />
            </View>

            <View>
              <SectionTitle>Last 7 days</SectionTitle>
              <View accessibilityLabel="Book time listened over the last seven days"
                style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8, height: 132, backgroundColor: C.surface, borderRadius: R.lg, borderWidth: 1, borderColor: C.line, padding: 12 }}>
                {stats.last7.map((d) => {
                  const total = d.book + d.estBook;
                  const solid = total > 0 ? Math.max(4, Math.round((d.book / barMax) * 96)) : 0;
                  const est = total > 0 && d.estBook > 0 ? Math.max(3, Math.round((d.estBook / barMax) * 96)) : 0;
                  const base = d.day === todayDay ? C.accent : C.accentDeep;
                  return (
                    <View key={d.day} style={{ flex: 1, alignItems: 'center', gap: 6 }}>
                      <View style={{ width: '100%', flex: 1, justifyContent: 'flex-end', borderRadius: 6, overflow: 'hidden' }}>
                        {est > 0 && <View style={{ height: est, backgroundColor: base, opacity: 0.4 }} />}
                        {solid > 0 && <View style={{ height: solid, backgroundColor: base }} />}
                      </View>
                      <Text style={[T.small, { fontSize: 10 }]}>{weekday(d.day)}</Text>
                    </View>
                  );
                })}
              </View>
            </View>

            <View>
              <SectionTitle>Streaks</SectionTitle>
              <View style={{ flexDirection: 'row', gap: 12 }}>
                <BigStat label="Current streak" value={`${stats.currentStreak} ${stats.currentStreak === 1 ? 'day' : 'days'}`} sub="5 min a day keeps it going" />
                <BigStat label="Longest streak" value={`${stats.longestStreak} ${stats.longestStreak === 1 ? 'day' : 'days'}`} />
              </View>
            </View>

            <View>
              <SectionTitle>Totals</SectionTitle>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
                <TinyStat label="Today" book={stats.todayBook} wall={stats.todayWall} est={stats.estToday} />
                <TinyStat label="This month" book={stats.monthBook} wall={stats.monthWall} est={stats.estMonth} />
                <TinyStat label="All time" book={stats.allBook} wall={stats.allWall} est={stats.estAll} />
              </View>
            </View>

            <View style={{ flexDirection: 'row', gap: 12 }}>
              <BigStat label="Books finished this year" value={`${stats.booksFinishedThisYear}`} />
              <BigStat label="Average speed" value={stats.averageSpeed > 0 ? `${stats.averageSpeed.toFixed(2)}×` : '—'}
                sub={stats.averageSpeed > 0 ? 'tracked time only' : ''} />
            </View>

            {stats.topBooks.length > 0 ? (
              <View>
                <SectionTitle>Top books this year</SectionTitle>
                <View style={{ backgroundColor: C.surface, borderRadius: R.lg, borderWidth: 1, borderColor: C.line, overflow: 'hidden' }}>
                  {stats.topBooks.map((b, i) => (
                    <View key={b.torrentId} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderTopWidth: i ? 1 : 0, borderTopColor: C.line }}>
                      <Cover title={b.title ?? 'Book'} uri={b.cover} size={44} radius={R.sm} />
                      <View style={{ flex: 1 }}>
                        <Text numberOfLines={1} style={[T.title, { fontSize: 15 }]}>{b.title ?? 'Unknown book'}</Text>
                        <Text style={T.small}>{b.estimated ? `${formatListeningHours(b.book)} · estimated` : formatListening(b.book)}</Text>
                      </View>
                      <Ionicons name="headset" size={16} color={C.faint} />
                    </View>
                  ))}
                </View>
              </View>
            ) : null}
          </>
        )}
      </ScrollView>
    </Sheet>
  );
}
