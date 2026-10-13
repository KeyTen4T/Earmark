import React, { useEffect, useRef, useState } from 'react';
import { View, PanResponder, Text, LayoutChangeEvent, findNodeHandle } from 'react-native';
import { C, fmtTime, pct } from '../theme';
import { isTV } from '../layout';

type Props = { position: number; duration: number; onSeek: (s: number) => void; step?: number }; // step: seconds per remote press (TV)

/** Draggable seek bar. Shows a live preview time while dragging and seeks on release. */
export function Scrubber(props: Props) {
  return isTV ? <TVScrubber {...props} /> : <TouchScrubber {...props} />;
}

const TV_COMMIT_MS = 800; // the seek happens once the remote has been still this long

/**
 * The seek bar for a remote. It takes the focus like a button; Left and Right then move the position.
 * React Native passes no arrow keys to JS inside a Modal, so the presses are read from the focus.
 * Three identical invisible focus targets are stacked over the bar and linked in a ring with
 * nextFocusLeft/nextFocusRight: Right moves the focus to the next one, Left to the previous one, and
 * which way it went is the key that was pressed. Up and Down leave the bar as from any other control.
 */
function TVScrubber({ position, duration, onSeek, step = 5 }: Props) {
  const refs = [useRef<View>(null), useRef<View>(null), useRef<View>(null)];
  const [tags, setTags] = useState<(number | null)[]>([null, null, null]);
  const [focused, setFocused] = useState(false);
  const [preview, setPreview] = useState<number | null>(null); // seconds, while nudging
  const target = useRef<number | null>(null);
  const at = useRef<number | null>(null); // which of the three has the focus; null when the bar has none
  const commit = useRef<ReturnType<typeof setTimeout> | null>(null);
  const leave = useRef<ReturnType<typeof setTimeout> | null>(null);
  const live = useRef({ position, duration, onSeek, step });
  live.current = { position, duration, onSeek, step };

  useEffect(() => { setTags(refs.map((r) => findNodeHandle(r.current))); }, []);
  useEffect(() => () => { if (commit.current) clearTimeout(commit.current); if (leave.current) clearTimeout(leave.current); }, []);

  const flush = () => {
    if (commit.current) clearTimeout(commit.current);
    commit.current = null;
    if (target.current !== null) live.current.onSeek(target.current);
    target.current = null;
    setPreview(null);
  };

  const nudge = (dir: -1 | 1) => {
    const { position: pos, duration: dur, step: seconds } = live.current;
    if (!(dur > 0)) return;
    target.current = Math.max(0, Math.min(dur - 1, (target.current ?? pos) + dir * seconds));
    setPreview(target.current);
    if (commit.current) clearTimeout(commit.current);
    commit.current = setTimeout(flush, TV_COMMIT_MS);
  };

  const onFocus = (i: number) => {
    if (leave.current) clearTimeout(leave.current);
    const from = at.current;
    at.current = i;
    setFocused(true);
    if (from !== null && from !== i) nudge((i - from + 3) % 3 === 1 ? 1 : -1);
  };
  const onBlur = () => {
    // Between two of the three the focus is nowhere for an instant; only a real departure counts.
    leave.current = setTimeout(() => { at.current = null; setFocused(false); flush(); }, 200);
  };

  const shown = preview ?? position;
  const f = duration > 0 ? Math.max(0, Math.min(1, shown / duration)) : 0;
  return (
    <View>
      <View style={{ height: 32, justifyContent: 'center' }}>
        <View style={{ height: focused ? 10 : 5, borderRadius: 5, backgroundColor: 'rgba(255,255,255,0.14)', overflow: 'hidden' }}>
          <View style={{ width: pct(f), height: '100%', backgroundColor: C.accent }} />
        </View>
        <View style={{
          position: 'absolute', left: pct(f), marginLeft: focused ? -12 : -8, width: focused ? 24 : 16, height: focused ? 24 : 16, borderRadius: 12,
          backgroundColor: '#fff', borderWidth: focused ? 3 : 0, borderColor: C.accent, elevation: 4,
        }} />
        {refs.map((r, i) => (
          <View key={i} ref={r} focusable accessible={i === 0} importantForAccessibility={i === 0 ? 'yes' : 'no'}
            accessibilityRole="adjustable" accessibilityLabel="Position, left and right to seek"
            accessibilityValue={{ min: 0, max: Math.round(duration || 0), now: Math.round(shown || 0), text: fmtTime(shown) }}
            {...({ nextFocusRight: tags[(i + 1) % 3] ?? undefined, nextFocusLeft: tags[(i + 2) % 3] ?? undefined } as object) /* Android view props the View typings omit */}
            onFocus={() => onFocus(i)} onBlur={onBlur}
            style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }} />
        ))}
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Text style={{ color: preview !== null ? C.accent : focused ? C.text : C.sub, fontSize: 12, fontVariant: ['tabular-nums'] }}>{fmtTime(shown)}</Text>
        {focused ? <Text style={{ color: C.sub, fontSize: 12 }}>◀ ▶ to seek</Text> : null}
        <Text style={{ color: C.sub, fontSize: 12, fontVariant: ['tabular-nums'] }}>-{fmtTime(Math.max(0, duration - shown))}</Text>
      </View>
    </View>
  );
}

function TouchScrubber({ position, duration, onSeek }: Props) {
  const [width, setWidth] = useState(1);
  const [drag, setDrag] = useState<number | null>(null);
  const w = useRef(1);
  const d = useRef(0);
  const startX = useRef(0);
  w.current = width;
  d.current = duration;

  const frac = (x: number) => Math.max(0, Math.min(1, x / w.current));
  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => d.current > 0,
    onMoveShouldSetPanResponder: () => d.current > 0,
    onPanResponderGrant: (e) => { startX.current = e.nativeEvent.locationX; setDrag(frac(startX.current)); },
    onPanResponderMove: (_e, g) => setDrag(frac(startX.current + g.dx)),
    onPanResponderRelease: (_e, g) => { const f = frac(startX.current + g.dx); setDrag(null); onSeekRef.current(f * d.current); },
    onPanResponderTerminate: () => setDrag(null),
  })).current;
  const onSeekRef = useRef(onSeek);
  onSeekRef.current = onSeek;

  const f = drag ?? (duration > 0 ? position / duration : 0);
  const shown = drag !== null ? drag * duration : position;
  return (
    <View>
      <View {...pan.panHandlers} focusable={false} accessible={!isTV} accessibilityRole="adjustable" accessibilityLabel="Position"
        accessibilityValue={{ min: 0, max: Math.round(duration || 0), now: Math.round(shown || 0), text: fmtTime(shown) }}
        onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)} style={{ height: 32, justifyContent: 'center' }}>
        <View pointerEvents="none" style={{ height: drag !== null ? 8 : 5, borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.14)', overflow: 'hidden' }}>
          <View style={{ width: pct(f), height: '100%', backgroundColor: C.accent }} />
        </View>
        <View pointerEvents="none" style={{
          position: 'absolute', left: f * width - 8, width: 16, height: 16, borderRadius: 8, backgroundColor: '#fff',
          transform: [{ scale: drag !== null ? 1.3 : 1 }], shadowColor: '#000', shadowOpacity: 0.4, shadowRadius: 4, elevation: 4,
        }} />
      </View>
      <View pointerEvents="none" style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Text style={{ color: drag !== null ? C.accent : C.sub, fontSize: 12, fontVariant: ['tabular-nums'] }}>{fmtTime(shown)}</Text>
        <Text style={{ color: C.sub, fontSize: 12, fontVariant: ['tabular-nums'] }}>-{fmtTime(Math.max(0, duration - shown))}</Text>
      </View>
    </View>
  );
}
