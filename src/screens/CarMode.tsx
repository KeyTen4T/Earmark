import React, { useEffect } from 'react';
import { View, Text, Modal, ActivityIndicator, useWindowDimensions, Platform } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { C, R, fmtTime, paletteFor } from '../theme';
import { Tap, Bar, SkipIcon } from '../components/ui';
import { usePlayer, usePlayerTick } from '../player/PlayerContext';
import { useEscape } from '../escape';
import { carProgress, carRemaining, carChapterLine } from '../player/car-mode';

// A tag so the screen-awake lock can be released exactly, even if another component asks for one too.
const KEEP_AWAKE_TAG = 'earmark-car-mode';

/**
 * Car mode: a full-screen overlay for a dash mount. Only the essentials, all oversized — the title,
 * a play/pause button big enough to hit without looking, the configured skips, chapter jumps, a
 * read-only progress bar and the player's error if there is one. It sits above the player in its own
 * Modal (so Android back and Escape close it first, leaving the player open) and keeps the screen on
 * for as long as it is visible. No sheets, no menus, no read-along text.
 */
export function CarMode({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const p = usePlayer();
  const t = usePlayerTick();
  const { height } = useWindowDimensions();
  // Inside a nested Android Modal the insets can be wrong, so reserve at least a three-button nav
  // bar the way the player does, keeping the bottom row clear.
  const insets = useSafeAreaInsets();
  const bottomPad = 16 + Math.max(insets.bottom, Platform.OS === 'android' ? 48 : 0);
  useEscape(onClose, visible);

  useEffect(() => {
    if (!visible) return;
    activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => {});
    return () => { deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {}); };
  }, [visible]);

  if (!p.book) return null;

  // Every control scales with the screen but never falls below the car-mode minimums.
  const play = Math.max(180, Math.min(216, Math.round(height * 0.28)));
  const skip = Math.max(120, Math.round(play * 0.68));
  const skipH = Math.max(64, Math.min(96, Math.round(skip * 0.5)));
  const titleSize = Math.max(26, Math.round(play * 0.14));
  const [c1] = paletteFor(p.book.name);
  const remaining = carRemaining(t.position, t.duration);
  const chapter = carChapterLine(p.chapterIndex, p.chapterCount, p.chapterName, p.displayTitle);
  const lastChapter = p.chapterIndex >= p.chapterCount - 1;

  const skipButton = (dir: 'back' | 'forward', seconds: number) => (
    <Tap onPress={() => p.skip(dir === 'back' ? -seconds : seconds)} haptic scaleTo={0.9}
      accessibilityLabel={dir === 'back' ? `Skip back ${seconds} seconds` : `Skip forward ${seconds} seconds`}
      style={{ width: skip, height: skipH, borderRadius: R.lg, alignItems: 'center', justifyContent: 'center', backgroundColor: C.elevated, borderWidth: 1, borderColor: C.line }}>
      <SkipIcon dir={dir} seconds={seconds} size={Math.round(play * 0.28)} color={C.text} />
    </Tap>
  );

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={{ flex: 1, backgroundColor: C.bg }}>
        <LinearGradient colors={[c1 + 'AA', C.bg]} locations={[0, 0.7]} style={{ position: 'absolute', left: 0, right: 0, top: 0, height: height * 0.7 }} />
        <SafeAreaView edges={['top']} style={{ flex: 1, paddingTop: 6, paddingBottom: bottomPad, paddingHorizontal: 20 }}>
          <Tap onPress={onClose} haptic scaleTo={0.97} accessibilityLabel="Exit car mode"
            style={{ height: 56, borderRadius: R.pill, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: C.elevated, borderWidth: 1, borderColor: C.line }}>
            <Ionicons name="chevron-down" size={22} color={C.text} />
            <Text style={{ color: C.text, fontWeight: '700', fontSize: 17 }}>Exit car mode</Text>
          </Tap>

          <View style={{ flex: 1, minHeight: 0, justifyContent: 'space-evenly' }}>
            <View>
              <Text numberOfLines={2} style={{ color: C.text, fontWeight: '800', fontSize: titleSize, letterSpacing: -0.5, lineHeight: titleSize + 4 }}>{p.displayTitle}</Text>
              <Text numberOfLines={1} style={{ color: C.sub, fontSize: 22, fontWeight: '600', lineHeight: 26, marginTop: 4 }}>{chapter}</Text>
              {p.error ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 12, padding: 12, borderRadius: R.md, backgroundColor: 'rgba(255,107,107,0.14)', borderWidth: 1, borderColor: C.danger }}>
                  <Ionicons name="alert-circle" size={22} color={C.danger} />
                  <Text numberOfLines={2} style={{ color: C.text, flex: 1, fontSize: 18, fontWeight: '600' }}>{p.error}</Text>
                  <Tap onPress={() => p.goChapter(p.index)} haptic scaleTo={0.94} accessibilityLabel="Retry"
                    style={{ height: 48, paddingHorizontal: 18, borderRadius: R.pill, backgroundColor: C.danger, alignItems: 'center', justifyContent: 'center' }}>
                    <Text style={{ color: '#1A0505', fontWeight: '800', fontSize: 16 }}>Retry</Text>
                  </Tap>
                </View>
              ) : null}
            </View>

            <View style={{ alignItems: 'center', gap: 12 }}>
              <Tap onPress={p.toggle} haptic scaleTo={0.95} accessibilityLabel={t.playing ? 'Pause' : 'Play'}
                accessibilityState={{ busy: t.loading || t.recovering }}
                style={{ width: play, height: play, borderRadius: play / 2, overflow: 'hidden' }}>
                <LinearGradient colors={[C.accent, C.accentDeep]} style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                  {t.loading || t.recovering ? <ActivityIndicator color={C.accentInk} size="large" /> : (
                    <Ionicons name={t.playing ? 'pause' : 'play'} size={Math.round(play * 0.4)} color={C.accentInk} style={{ marginLeft: t.playing ? 0 : 6 }} />
                  )}
                </LinearGradient>
              </Tap>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 28 }}>
                {skipButton('back', p.skipBack)}
                {skipButton('forward', p.skipForward)}
              </View>
            </View>

            <View>
              <Bar value={carProgress(t.position, t.duration)} height={5} />
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 }}>
                <Text style={{ color: C.text, fontSize: 22, fontWeight: '700', lineHeight: 26, fontVariant: ['tabular-nums'] }}>{fmtTime(t.position)}</Text>
                <Text style={{ color: C.sub, fontSize: 22, fontWeight: '700', lineHeight: 26, fontVariant: ['tabular-nums'] }}>-{fmtTime(remaining)}</Text>
              </View>
            </View>
          </View>

          <View style={{ flexDirection: 'row', gap: 12, marginTop: 10 }}>
            <Tap onPress={p.prevChapter} haptic scaleTo={0.97} accessibilityLabel="Previous chapter"
              style={{ flex: 1, height: 88, borderRadius: R.lg, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, backgroundColor: C.elevated, borderWidth: 1, borderColor: C.line }}>
              <Ionicons name="play-skip-back" size={26} color={C.text} />
              <Text style={{ color: C.text, fontWeight: '700', fontSize: 18 }}>Previous</Text>
            </Tap>
            <Tap onPress={p.nextChapter} haptic disabled={lastChapter} scaleTo={0.97} accessibilityLabel="Next chapter"
              accessibilityState={{ disabled: lastChapter }}
              style={{ flex: 1, height: 88, borderRadius: R.lg, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, backgroundColor: C.elevated, borderWidth: 1, borderColor: C.line }}>
              <Text style={{ color: C.text, fontWeight: '700', fontSize: 18 }}>Next</Text>
              <Ionicons name="play-skip-forward" size={26} color={C.text} />
            </Tap>
          </View>
        </SafeAreaView>
      </View>
    </Modal>
  );
}
