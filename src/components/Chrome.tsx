import React, { useEffect, useRef } from 'react';
import { View, Text, Animated, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { C, R, T, pct } from '../theme';
import { Tap, Cover, Pop, FadeIn, Button, IconButton, IconName, SkipIcon } from './ui';
import { Scrubber } from './Scrubber';
import { SIDEBAR_WIDTH } from '../layout';
import { usePlayer } from '../player/PlayerContext';

export type Tab = 'library' | 'search' | 'sources';
/** A full-player sheet the desktop bar can ask to open straight away. */
export type PlayerBarSheet = 'speed' | 'sleep' | 'chapters';
const TABS: { key: Tab; label: string; icon: IconName; active: IconName }[] = [
  { key: 'library', label: 'Library', icon: 'library-outline', active: 'library' },
  { key: 'search', label: 'Discover', icon: 'search-outline', active: 'search' },
  { key: 'sources', label: 'Settings', icon: 'settings-outline', active: 'settings' },
];
export const TAB_BAR_HEIGHT = 62;
export const PLAYER_BAR_HEIGHT = 104;

export function TabBar({ tab, onChange }: { tab: Tab; onChange: (t: Tab) => void }) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const slot = width / TABS.length;
  const PILL = 58;
  // One highlight pill that slides between the tabs instead of blinking from one to the next.
  const index = TABS.findIndex((t) => t.key === tab);
  const x = useRef(new Animated.Value(index)).current;
  useEffect(() => {
    Animated.spring(x, { toValue: index, useNativeDriver: true, damping: 18, stiffness: 220, mass: 0.8 }).start();
  }, [index]);
  return (
    <View style={{
      flexDirection: 'row', backgroundColor: 'rgba(12,12,18,0.98)', borderTopWidth: 1, borderTopColor: C.line,
      paddingBottom: insets.bottom, height: TAB_BAR_HEIGHT + insets.bottom,
    }}>
      <Animated.View pointerEvents="none" style={{
        position: 'absolute', top: (TAB_BAR_HEIGHT - 17 - 30) / 2, left: (slot - PILL) / 2, width: PILL, height: 30, borderRadius: 15,
        backgroundColor: 'rgba(255,181,71,0.14)', transform: [{ translateX: Animated.multiply(x, slot) }],
      }} />
      {TABS.map((t) => {
        const on = t.key === tab;
        return (
          <Tap key={t.key} onPress={() => onChange(t.key)} haptic scaleTo={0.9} accessibilityRole="tab" accessibilityState={{ selected: on }} accessibilityLabel={t.label} style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 3 }}>
            <Pop on={on} from={on ? 0.7 : 1} style={{ height: 30, justifyContent: 'center' }}>
              <Ionicons name={on ? t.active : t.icon} size={22} color={on ? C.accent : C.faint} />
            </Pop>
            <Text style={{ fontSize: 11, fontWeight: '700', color: on ? C.text : C.faint }}>{t.label}</Text>
          </Tap>
        );
      })}
    </View>
  );
}

export function MiniPlayer({ onOpen }: { onOpen: () => void }) {
  const p = usePlayer();
  if (!p.book) return null;
  const frac = p.duration > 0 ? p.position / p.duration : 0;
  return (
    <FadeIn y={40}>
    <Tap onPress={onOpen} scaleTo={0.98} style={{
      marginHorizontal: 10, marginBottom: 8, borderRadius: R.lg, backgroundColor: C.elevated, overflow: 'hidden',
      borderWidth: 1, borderColor: C.line, shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 16, elevation: 12,
    }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', padding: 8, gap: 12 }}>
        <Cover title={p.book.name} uri={p.meta.cover} size={46} radius={10} />
        <View style={{ flex: 1 }}>
          <Text numberOfLines={1} style={{ color: C.text, fontWeight: '700', fontSize: 14 }}>{p.displayTitle}</Text>
          <Text numberOfLines={1} style={{ color: C.sub, fontSize: 12, marginTop: 2 }}>
            {p.error ? p.error : p.recovering ? 'Reconnecting…' : p.loading ? 'Loading…' : p.chapterName}
          </Text>
        </View>
        <Tap onPress={() => p.skip(-p.skipBack)} hitSlop={8} scaleTo={0.85} accessibilityLabel={`Skip back ${p.skipBack} seconds`} style={{ padding: 6 }}>
          <SkipIcon dir="back" seconds={p.skipBack} size={20} color={C.sub} />
        </Tap>
        <Tap onPress={p.toggle} haptic hitSlop={8} scaleTo={0.85} accessibilityLabel={p.playing ? 'Pause' : 'Play'} style={{ width: 42, height: 42, borderRadius: 21, backgroundColor: C.text, alignItems: 'center', justifyContent: 'center' }}>
          <Pop on={p.playing} from={0.6}>
            <Ionicons name={p.playing ? 'pause' : 'play'} size={20} color={C.bg} style={{ marginLeft: p.playing ? 0 : 2 }} />
          </Pop>
        </Tap>
      </View>
      <View style={{ height: 2, backgroundColor: 'rgba(255,255,255,0.08)' }}>
        <View style={{ height: 2, width: pct(frac), backgroundColor: C.accent }} />
      </View>
    </Tap>
    </FadeIn>
  );
}

const NAV_ROW = 46;

/** Desktop navigation: the tabs down the left side, with the one way to add a book always in reach. */
export function Sidebar({ tab, onChange, onAdd }: { tab: Tab; onChange: (t: Tab) => void; onAdd: () => void }) {
  const index = TABS.findIndex((t) => t.key === tab);
  const y = useRef(new Animated.Value(index)).current;
  useEffect(() => {
    Animated.spring(y, { toValue: index, useNativeDriver: true, damping: 18, stiffness: 220, mass: 0.8 }).start();
  }, [index]);
  return (
    <View style={{ width: SIDEBAR_WIDTH, backgroundColor: C.surface, borderRightWidth: 1, borderRightColor: C.line, paddingHorizontal: 14, paddingTop: 22, paddingBottom: 16 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 8, marginBottom: 26 }}>
        <View style={{ width: 34, height: 34, borderRadius: 10, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center' }}>
          <Ionicons name="headset" size={19} color={C.accentInk} />
        </View>
        <Text style={[T.h2, { fontSize: 19 }]}>Earmark</Text>
      </View>
      <View>
        <Animated.View pointerEvents="none" style={{
          position: 'absolute', left: 0, right: 0, top: 0, height: NAV_ROW - 6, borderRadius: R.md,
          backgroundColor: 'rgba(255,181,71,0.14)', transform: [{ translateY: Animated.multiply(y, NAV_ROW) }],
        }} />
        {TABS.map((t) => {
          const on = t.key === tab;
          return (
            <Tap key={t.key} onPress={() => onChange(t.key)} scaleTo={0.98} accessibilityRole="button" accessibilityState={{ selected: on }} accessibilityLabel={t.label} hoverStyle={{ backgroundColor: C.hover, borderRadius: R.md }} style={{ height: NAV_ROW - 6, marginBottom: 6, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 12 }}>
              <Ionicons name={on ? t.active : t.icon} size={19} color={on ? C.accent : C.sub} />
              <Text style={{ fontSize: 14, fontWeight: '700', color: on ? C.text : C.sub }}>{t.label}</Text>
            </Tap>
          );
        })}
      </View>
      <View style={{ flex: 1 }} />
      <Button label="Add a book" icon="add" onPress={onAdd} />
      <Text style={[T.small, { textAlign: 'center', marginTop: 10 }]}>Paste a magnet or pick a .torrent</Text>
    </View>
  );
}

/** Desktop now-playing bar across the bottom of the window. */
export function PlayerBar({ onOpen }: { onOpen: (sheet?: PlayerBarSheet) => void }) {
  const p = usePlayer();
  if (!p.book) return null;
  return (
    <FadeIn y={30}>
      <View style={{ height: PLAYER_BAR_HEIGHT, backgroundColor: C.elevated, borderTopWidth: 1, borderTopColor: C.line, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 18, gap: 20 }}>
        <Tap onPress={() => onOpen()} scaleTo={0.98} style={{ width: 280, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <Cover title={p.book.name} uri={p.meta.cover} size={58} radius={10} />
          <View style={{ flex: 1 }}>
            <Text numberOfLines={1} style={{ color: C.text, fontWeight: '700', fontSize: 14 }}>{p.displayTitle}</Text>
            <Text numberOfLines={1} style={{ color: C.sub, fontSize: 12, marginTop: 3 }}>{p.error ? p.error : p.recovering ? 'Reconnecting…' : p.loading ? 'Loading…' : p.chapterName}</Text>
          </View>
        </Tap>
        <View style={{ flex: 1, maxWidth: 720, alignSelf: 'center' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 14, marginBottom: -4 }}>
            <IconButton label="Previous chapter" name="play-skip-back" size={18} color={C.sub} onPress={() => (p.position > 5 ? p.seek(0) : p.goChapter(p.index - 1))} />
            <Tap onPress={() => p.skip(-p.skipBack)} hitSlop={8} scaleTo={0.88} accessibilityLabel={`Skip back ${p.skipBack} seconds`} style={{ width: 30, height: 30, alignItems: 'center', justifyContent: 'center' }}>
              <SkipIcon dir="back" seconds={p.skipBack} size={24} color={C.sub} />
            </Tap>
            <Tap onPress={p.toggle} scaleTo={0.88} accessibilityLabel={p.playing ? 'Pause' : 'Play'} style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: C.text, alignItems: 'center', justifyContent: 'center' }}>
              <Pop on={p.playing} from={0.6}>
                <Ionicons name={p.playing ? 'pause' : 'play'} size={19} color={C.bg} style={{ marginLeft: p.playing ? 0 : 2 }} />
              </Pop>
            </Tap>
            <Tap onPress={() => p.skip(p.skipForward)} hitSlop={8} scaleTo={0.88} accessibilityLabel={`Skip forward ${p.skipForward} seconds`} style={{ width: 30, height: 30, alignItems: 'center', justifyContent: 'center' }}>
              <SkipIcon dir="forward" seconds={p.skipForward} size={24} color={C.sub} />
            </Tap>
            <IconButton label="Next chapter" name="play-skip-forward" size={18} color={C.sub} disabled={p.index >= p.chapters.length - 1} onPress={() => p.goChapter(p.index + 1)} />
          </View>
          <Scrubber position={p.position} duration={p.duration} onSeek={p.seek} />
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 2 }}>
          <Text numberOfLines={1} style={{ color: C.sub, fontSize: 12, fontWeight: '700', marginRight: 4 }}>Chapter {p.index + 1} of {p.chapters.length}</Text>
          <Tap onPress={() => onOpen('speed')} scaleTo={0.9} hitSlop={7} hoverStyle={{ backgroundColor: C.hover }}
            style={{ height: 30, paddingHorizontal: 10, borderRadius: R.pill, backgroundColor: C.elevated, borderWidth: 1, borderColor: p.rate !== 1 ? C.accent : C.line, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ color: p.rate !== 1 ? C.accent : C.text, fontSize: 12, fontWeight: '800', fontVariant: ['tabular-nums'] }}>{p.rate}×</Text>
          </Tap>
          <IconButton label="Sleep timer" name="moon-outline" size={18} color={p.sleep ? C.accent : C.sub} bg={p.sleep ? 'rgba(255,181,71,0.15)' : undefined} onPress={() => onOpen('sleep')} />
          <IconButton label="Chapters" name="list" size={18} color={C.sub} onPress={() => onOpen('chapters')} />
          <IconButton label="Open player" name="chevron-up" size={20} onPress={() => onOpen()} />
        </View>
      </View>
    </FadeIn>
  );
}
