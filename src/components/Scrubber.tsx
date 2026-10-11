import React, { useRef, useState } from 'react';
import { View, PanResponder, Text, LayoutChangeEvent } from 'react-native';
import { C, fmtTime, pct } from '../theme';

/** Draggable seek bar. Shows a live preview time while dragging and seeks on release. */
export function Scrubber({ position, duration, onSeek }: { position: number; duration: number; onSeek: (s: number) => void }) {
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
      <View {...pan.panHandlers} accessible accessibilityRole="adjustable" accessibilityLabel="Position"
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
