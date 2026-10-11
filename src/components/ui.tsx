import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, Easing, PanResponder, Platform, ScrollView, Pressable, PressableProps, StyleProp, ViewStyle, Text, View, Modal, StyleSheet, ActivityIndicator, Keyboard, Vibration, useWindowDimensions, Alert } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { C, R, T, paletteFor, prettyName, pct } from '../theme';
import { shouldAnimateProgress } from '../player/visibility';
import { useLayout } from '../layout';
import { useEscape } from '../escape';

export type IconName = React.ComponentProps<typeof Ionicons>['name'];

/** A short buzz you can feel under your thumb: 'tick' for selections, 'bump' for something that happened. */
export const haptic = (kind: 'tick' | 'bump' = 'tick') => { try { Vibration.vibrate(kind === 'tick' ? 8 : 18); } catch { /* no vibrator */ } };

/** Scale that springs back from a squeeze every time `trigger` changes (not on first render). */
export function usePop(trigger: unknown, from = 0.8) {
  const v = useRef(new Animated.Value(1)).current;
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    v.setValue(from);
    Animated.spring(v, { toValue: 1, useNativeDriver: true, speed: 18, bounciness: 14 }).start();
  }, [trigger]);
  return v;
}

/** Wraps something (an icon, say) so it pops whenever `on` changes. */
export function Pop({ on, from, style, children }: { on: unknown; from?: number; style?: StyleProp<ViewStyle>; children: React.ReactNode }) {
  const v = usePop(on, from);
  return <Animated.View style={[style, { transform: [{ scale: v }] }]}>{children}</Animated.View>;
}

/** Fades and slides its children in when it appears. `index` staggers the first few items of a list. */
export function FadeIn({ index = 0, delay = 0, y = 16, style, children }: { index?: number; delay?: number; y?: number; style?: StyleProp<ViewStyle>; children: React.ReactNode }) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    // Only the first screenful waits its turn; rows that scroll in later shouldn't lag behind the finger.
    Animated.timing(v, { toValue: 1, duration: 360, delay: delay + (index < 9 ? index * 45 : 0), easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, []);
  return <Animated.View style={[style, { opacity: v, transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [y, 0] }) }] }]}>{children}</Animated.View>;
}

/** Placeholder block that breathes while the real thing loads. */
export function Skeleton({ width, height, radius = R.md, style }: { width?: number | `${number}%`; height: number; radius?: number; style?: StyleProp<ViewStyle> }) {
  const v = useRef(new Animated.Value(0.45)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(v, { toValue: 1, duration: 700, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      Animated.timing(v, { toValue: 0.45, duration: 700, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, []);
  return <Animated.View style={[{ width, height, borderRadius: radius, backgroundColor: C.elevated, opacity: v }, style]} />;
}

/** Scroll position for a screen, wired for the native driver. Spread `onScroll` onto an Animated list. */
export function useScrollY() {
  const y = useRef(new Animated.Value(0)).current;
  const onScroll = useMemo(() => Animated.event([{ nativeEvent: { contentOffset: { y } } }], { useNativeDriver: true }), []);
  return { y, onScroll };
}

/** The big screen title. Shrinks and fades as the page scrolls; StickyBar takes over from it. */
export function HeroHeader({ y, label, title, right, style }: { y: Animated.Value; label: string; title: string; right?: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  const fade = y.interpolate({ inputRange: [0, 70], outputRange: [1, 0], extrapolate: 'clamp' });
  const scale = y.interpolate({ inputRange: [0, 90], outputRange: [1, 0.86], extrapolate: 'clamp' });
  const lift = y.interpolate({ inputRange: [0, 90], outputRange: [0, 18], extrapolate: 'clamp' });
  return (
    <View style={[{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' }, style]}>
      <Animated.View style={{ opacity: fade, transform: [{ translateY: lift }, { scale }], transformOrigin: 'left bottom' } as any}>
        <Text style={T.label}>{label}</Text>
        <Text style={[T.hero, { marginTop: 4 }]}>{title}</Text>
      </Animated.View>
      {right}
    </View>
  );
}

/** Slim title bar that fades in over the top of the screen once the hero title has scrolled away. */
export function StickyBar({ y, title }: { y: Animated.Value; title: string }) {
  const insets = useSafeAreaInsets();
  const show = y.interpolate({ inputRange: [50, 100], outputRange: [0, 1], extrapolate: 'clamp' });
  const drop = y.interpolate({ inputRange: [50, 100], outputRange: [-8, 0], extrapolate: 'clamp' });
  return (
    <Animated.View pointerEvents="none" style={{
      position: 'absolute', left: 0, right: 0, top: 0, height: insets.top + 46, paddingTop: insets.top, opacity: show,
      backgroundColor: 'rgba(10,10,15,0.96)', borderBottomWidth: 1, borderBottomColor: C.line, alignItems: 'center', justifyContent: 'center',
    }}>
      <Animated.Text style={{ color: C.text, fontWeight: '700', fontSize: 16, transform: [{ translateY: drop }] }}>{title}</Animated.Text>
    </Animated.View>
  );
}

/**
 * Pressable that gently scales down while held. `haptic` adds a tick when pressed.
 * `onMenu` opens the item's options: a long press on a phone, a right-click on desktop.
 */
export function Tap({ style, children, scaleTo = 0.96, haptic: buzz, onMenu, hoverStyle, accessibilityLabel, accessibilityRole = 'button', accessibilityState, ...rest }: Omit<PressableProps, 'style' | 'children'> & { style?: StyleProp<ViewStyle>; scaleTo?: number; haptic?: boolean; onMenu?: () => void; hoverStyle?: StyleProp<ViewStyle>; children?: React.ReactNode }) {
  const v = useRef(new Animated.Value(1)).current;
  // Hover is a desktop nicety only: on a touch screen these never fire, so the mobile look is untouched.
  const [hovered, setHovered] = React.useState(false);
  const to = (x: number) => Animated.spring(v, { toValue: x, useNativeDriver: true, speed: 40, bounciness: 6 }).start();
  // The style goes on the inner view, but how the button sizes itself within its parent
  // (flex: 1 in a row of tabs, say) has to be on the outer Pressable or it's ignored.
  const { flex, flexGrow, flexShrink, flexBasis, alignSelf, ...inner } = StyleSheet.flatten(style) ?? {};
  // The inner view must not get `flex: 1` too: on Android that sets a zero flex basis, which beats
  // `height` inside the auto-height Pressable and collapses the button to a sliver (the player's
  // bottom row). It only needs to fill whatever space the Pressable was given.
  const innerStyle: ViewStyle = flex != null || flexGrow != null ? { ...inner, flexGrow: 1 } : inner;
  const menuProps: any = !onMenu ? null : Platform.OS === 'web'
    ? { onContextMenu: (e: any) => { e.preventDefault(); e.stopPropagation(); onMenu(); } }
    : { onLongPress: () => { haptic('bump'); onMenu(); } };
  return (
    <Pressable {...rest} {...menuProps} accessibilityLabel={accessibilityLabel} accessibilityRole={accessibilityRole} accessibilityState={accessibilityState} style={{ flex, flexGrow, flexShrink, flexBasis, alignSelf }}
      onPress={rest.onPress ? (e) => { if (buzz) haptic(); rest.onPress?.(e); } : undefined}
      onHoverIn={(e) => { if (Platform.OS === 'web') setHovered(true); rest.onHoverIn?.(e); }}
      onHoverOut={(e) => { if (Platform.OS === 'web') setHovered(false); rest.onHoverOut?.(e); }}
      onPressIn={(e) => { to(scaleTo); rest.onPressIn?.(e); }} onPressOut={(e) => { to(1); rest.onPressOut?.(e); }}>
      <Animated.View style={[innerStyle, { transform: [{ scale: v }] }, rest.disabled ? { opacity: 0.45 } : null, hovered && !rest.disabled ? hoverStyle : null]}>{children}</Animated.View>
    </Pressable>
  );
}

export function Cover({ title, uri, size, radius = R.md, style, accessible = false }: { title: string; uri?: string; size: number; radius?: number; style?: StyleProp<ViewStyle>; accessible?: boolean }) {
  const [a, b] = paletteFor(title);
  const clean = prettyName(title);
  const initials = clean.split(/\s+/).filter((w) => /^[a-z0-9]/i.test(w)).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
  const [failed, setFailed] = React.useState(false);
  const fade = useRef(new Animated.Value(0)).current;
  React.useEffect(() => { setFailed(false); fade.setValue(0); }, [uri]);
  return (
    <View accessible={accessible} accessibilityElementsHidden={!accessible} importantForAccessibility={accessible ? 'auto' : 'no-hide-descendants'}
      style={[{ width: size, height: size, borderRadius: radius, overflow: 'hidden', backgroundColor: C.elevated }, style]}>
      <LinearGradient colors={[a, b]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
      {(!uri || failed) && (
        <View style={[StyleSheet.absoluteFill, { padding: size * 0.1, justifyContent: 'space-between' }]}>
          <Ionicons name="headset" size={Math.max(12, size * 0.14)} color="rgba(255,255,255,0.55)" />
          {size >= 90 ? (
            <Text numberOfLines={3} style={{ color: '#fff', fontWeight: '800', fontSize: size * 0.11, letterSpacing: -0.3 }}>{clean}</Text>
          ) : (
            <Text style={{ color: '#fff', fontWeight: '800', fontSize: size * 0.32 }}>{initials}</Text>
          )}
        </View>
      )}
      {!!uri && !failed && (
        <Animated.Image source={{ uri }} style={[StyleSheet.absoluteFill, { opacity: fade }]} resizeMode="cover" onError={() => setFailed(true)}
          onLoad={() => Animated.timing(fade, { toValue: 1, duration: 280, useNativeDriver: true }).start()} />
      )}
    </View>
  );
}

export function Bar({ value, height = 4, color = C.accent, track = 'rgba(255,255,255,0.12)' }: { value: number; height?: number; color?: string; track?: string }) {
  // Fills from empty when it appears and glides to each new value. The playhead moves in tiny steps
  // every status tick, so only a real jump animates; anything smaller is set directly.
  const v = useRef(new Animated.Value(0)).current;
  const target = useRef(0);
  useEffect(() => {
    const to = Math.max(0, Math.min(1, value || 0));
    if (shouldAnimateProgress(target.current, to)) {
      Animated.timing(v, { toValue: to, duration: 500, easing: Easing.out(Easing.cubic), useNativeDriver: false }).start();
    } else {
      v.setValue(to);
    }
    target.current = to;
  }, [value]);
  return (
    <View style={{ height, borderRadius: height, backgroundColor: track, overflow: 'hidden' }}>
      <Animated.View style={{ width: v.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }), height, backgroundColor: color, borderRadius: height }} />
    </View>
  );
}

export function Button({ label, icon, onPress, kind = 'primary', loading, disabled, style }: {
  label: string; icon?: IconName; onPress?: () => void; kind?: 'primary' | 'ghost' | 'danger'; loading?: boolean; disabled?: boolean; style?: StyleProp<ViewStyle>;
}) {
  const primary = kind === 'primary';
  const fg = primary ? C.accentInk : kind === 'danger' ? C.danger : C.text;
  const inner = (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 18, height: 50 }}>
      {loading ? <ActivityIndicator color={fg} /> : icon ? <Ionicons name={icon} size={18} color={fg} /> : null}
      <Text style={{ color: fg, fontWeight: '700', fontSize: 15 }}>{label}</Text>
    </View>
  );
  return (
    <Tap accessibilityLabel={label} accessibilityState={{ disabled: !!(disabled || loading), busy: !!loading }} onPress={onPress} haptic disabled={disabled || loading} hoverStyle={{ opacity: 0.9 }} style={[{ borderRadius: R.pill, overflow: 'hidden' }, !primary && { backgroundColor: C.elevated, borderWidth: 1, borderColor: C.line }, style]}>
      {primary ? <LinearGradient colors={[C.accent, C.accentDeep]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}>{inner}</LinearGradient> : inner}
    </Tap>
  );
}

export function IconButton({ name, label, onPress, size = 22, color = C.text, bg, style, disabled }: {
  name: IconName; label: string; onPress?: () => void; size?: number; color?: string; bg?: string; style?: StyleProp<ViewStyle>; disabled?: boolean;
}) {
  const box = size + 20;
  // A small icon still needs a fingertip-sized target: grow the slop until the box reaches 44px.
  const hitSlop = Math.max(8, Math.ceil((44 - box) / 2));
  return (
    <Tap accessibilityLabel={label} onPress={onPress} haptic disabled={disabled} hitSlop={hitSlop} scaleTo={0.88} hoverStyle={{ backgroundColor: C.hover }}
      style={[{ width: box, height: box, borderRadius: box / 2, alignItems: 'center', justifyContent: 'center', backgroundColor: bg }, style]}>
      <Ionicons name={name} size={size} color={color} />
    </Tap>
  );
}

export function SkipIcon({ dir, seconds, size = 34, color = C.text }: { dir: 'back' | 'forward'; seconds: number; size?: number; color?: string }) {
  const known = [5, 10, 15, 30, 45, 60];
  const name = (dir === 'back' ? `rewind-${seconds}` : `fast-forward-${seconds}`) as any;
  if (known.includes(seconds)) return <MaterialCommunityIcons name={name} size={size} color={color} />;
  return <Ionicons name={dir === 'back' ? 'play-back' : 'play-forward'} size={size - 4} color={color} />;
}

export function Chip({ label, active, onPress, icon, accessibilityLabel }: { label: string; active?: boolean; onPress?: () => void; icon?: IconName; accessibilityLabel?: string }) {
  const pop = usePop(!!active, 0.88);
  return (
    <Animated.View style={{ transform: [{ scale: pop }] }}>
      <Tap accessibilityLabel={accessibilityLabel ?? label} accessibilityState={{ selected: !!active }} onPress={onPress} haptic hitSlop={5} style={{
        paddingHorizontal: 14, height: 34, borderRadius: R.pill, flexDirection: 'row', alignItems: 'center', gap: 6,
        backgroundColor: active ? C.accent : C.elevated, borderWidth: 1, borderColor: active ? C.accent : C.line,
      }}>
        {icon ? <Ionicons name={icon} size={13} color={active ? C.accentInk : C.sub} /> : null}
        <Text numberOfLines={1} style={{ color: active ? C.accentInk : C.sub, fontWeight: '700', fontSize: 13, maxWidth: 200 }}>{label}</Text>
      </Tap>
    </Animated.View>
  );
}

/** The small green badge that marks a full-cast or dramatised recording. */
export function FullCastChip() {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2, backgroundColor: 'rgba(74,222,128,0.15)', borderRadius: 6, paddingHorizontal: 5, paddingVertical: 1 }}>
      <Ionicons name="people" size={10} color={C.good} />
      <Text style={{ color: C.good, fontSize: 10, fontWeight: '800' }}>FULL CAST</Text>
    </View>
  );
}

/** A row of chips: swipes sideways on a phone, wraps onto more lines on desktop where there's no swiping. */
export function ChipRow({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  const { wide } = useLayout();
  if (wide) return <View style={[{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 20 }, style]}>{children}</View>;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={[{ paddingHorizontal: 20, gap: 8 }, style]}>
      {children}
    </ScrollView>
  );
}

/** Height of the on-screen keyboard, 0 when hidden. Android draws edge-to-edge, so nothing moves out of its way for us. */
export function useKeyboardHeight() {
  const [h, setH] = React.useState(0);
  React.useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', (e) => setH(e.endCoordinates.height));
    const hide = Keyboard.addListener('keyboardDidHide', () => setH(0));
    return () => { show.remove(); hide.remove(); };
  }, []);
  return h;
}

/** Bottom sheet built on Modal, with a dimmed backdrop that closes it. Lifts itself above the keyboard. */
export function Sheet({ visible, onClose, title, children }: { visible: boolean; onClose: () => void; title?: string; children: React.ReactNode }) {
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const { wide, dialogWidth } = useLayout();
  const kb = useKeyboardHeight();
  const maxHeight = kb ? height - kb - insets.top - 12 : height * 0.8;
  useEscape(onClose, visible);

  // The backdrop fades while the sheet springs up, and both play in reverse on the way out, so the
  // Modal has to outlive `visible` by the length of the closing animation, with its last contents.
  const [mounted, setMounted] = React.useState(visible);
  const open = useRef(new Animated.Value(0)).current;
  const drag = useRef(new Animated.Value(0)).current;
  const last = useRef({ title, children });
  if (visible) last.current = { title, children };
  useEffect(() => {
    if (visible) {
      setMounted(true);
      drag.setValue(0);
      Animated.spring(open, { toValue: 1, useNativeDriver: true, damping: 24, stiffness: 260, mass: 0.9 }).start();
    } else {
      Animated.timing(open, { toValue: 0, duration: 210, easing: Easing.in(Easing.cubic), useNativeDriver: true }).start(({ finished }) => { if (finished) setMounted(false); });
    }
  }, [visible]);

  // Pull the handle down to dismiss; let go early and it springs back.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: (_e, g) => g.dy > 4,
    onPanResponderMove: (_e, g) => drag.setValue(Math.max(0, g.dy)),
    onPanResponderRelease: (_e, g) => {
      if (g.dy > 110 || g.vy > 0.9) { haptic(); closeRef.current(); }
      else Animated.spring(drag, { toValue: 0, useNativeDriver: true, bounciness: 8 }).start();
    },
    onPanResponderTerminate: () => Animated.spring(drag, { toValue: 0, useNativeDriver: true }).start(),
  })).current;

  // On desktop it's a dialog in the middle of the window that eases up a little, not a sheet from the bottom edge.
  const slide = Animated.add(open.interpolate({ inputRange: [0, 1], outputRange: [wide ? 28 : height * 0.7, 0] }), drag);
  return (
    <Modal visible={mounted} transparent animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <View pointerEvents={visible ? 'auto' : 'none'} style={{ flex: 1, justifyContent: wide ? 'center' : 'flex-end', alignItems: wide ? 'center' : undefined }}>
        <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.6)', opacity: open }]}>
          <Pressable style={{ flex: 1 }} onPress={onClose} />
        </Animated.View>
        <Animated.View accessibilityViewIsModal style={[{ backgroundColor: C.surface, borderTopLeftRadius: R.xl, borderTopRightRadius: R.xl, paddingBottom: (kb || insets.bottom) + 12, maxHeight: maxHeight + (kb || 0), borderTopWidth: 1, borderColor: C.line, transform: [{ translateY: slide }] },
          wide && { width: dialogWidth, borderRadius: R.xl, borderWidth: 1, paddingBottom: 20, opacity: open }]}>
          <View {...(wide ? {} : pan.panHandlers)}>
            {wide ? <View style={{ height: 14 }} /> : <View style={{ alignSelf: 'center', width: 40, height: 5, borderRadius: 3, backgroundColor: C.line, marginTop: 10, marginBottom: 8 }} />}
            {last.current.title ? <Text accessibilityRole="header" style={[T.h2, { paddingHorizontal: 20, paddingVertical: 8 }]}>{last.current.title}</Text> : null}
          </View>
          {last.current.children}
        </Animated.View>
      </View>
    </Modal>
  );
}

export function Empty({ icon, title, body, action }: { icon: IconName; title: string; body?: string; action?: React.ReactNode }) {
  return (
    <View style={{ alignItems: 'center', paddingHorizontal: 32, paddingVertical: 56, gap: 10 }}>
      <View style={{ width: 76, height: 76, borderRadius: 38, backgroundColor: C.elevated, alignItems: 'center', justifyContent: 'center', marginBottom: 6 }}>
        <Ionicons name={icon} size={34} color={C.accent} />
      </View>
      <Text style={[T.h2, { textAlign: 'center' }]}>{title}</Text>
      {body ? <Text style={[T.body, { textAlign: 'center', lineHeight: 20 }]}>{body}</Text> : null}
      {action ? <View style={{ marginTop: 10 }}>{action}</View> : null}
    </View>
  );
}

let toastSetter: ((m: { text: string; kind: 'ok' | 'err' } | null) => void) | null = null;
export const toast = (text: string, kind: 'ok' | 'err' = 'ok') => toastSetter?.({ text, kind });

/** The app's yes/no confirmation: a native Alert on a phone, the window's own confirm on desktop. */
export async function confirmAction(title: string, message: string, confirmLabel: string): Promise<boolean> {
  if (Platform.OS === 'web') return !!(globalThis as any).confirm?.(`${title}\n\n${message}`);
  return new Promise<boolean>((done) => Alert.alert(title, message, [
    { text: 'Cancel', style: 'cancel', onPress: () => done(false) },
    { text: confirmLabel, style: 'destructive', onPress: () => done(true) },
  ], { cancelable: true, onDismiss: () => done(false) }));
}

export function ToastHost() {
  const [msg, setMsg] = React.useState<{ text: string; kind: 'ok' | 'err' } | null>(null);
  const y = useRef(new Animated.Value(0)).current;
  const insets = useSafeAreaInsets();
  React.useEffect(() => {
    toastSetter = (m) => {
      setMsg(m);
      y.setValue(0);
      Animated.sequence([
        Animated.spring(y, { toValue: 1, useNativeDriver: true }),
        Animated.delay(2600),
        Animated.timing(y, { toValue: 0, duration: 220, useNativeDriver: true }),
      ]).start(() => setMsg(null));
    };
    return () => { toastSetter = null; };
  }, []);
  if (!msg) return null;
  return (
    <Animated.View pointerEvents="none" style={{
      position: 'absolute', left: 16, right: 16, top: insets.top + 8, zIndex: 100, maxWidth: 520, alignSelf: 'center', width: '100%',
      opacity: y, transform: [{ translateY: y.interpolate({ inputRange: [0, 1], outputRange: [-30, 0] }) }],
    }}>
      <View style={{ backgroundColor: C.elevated, borderRadius: R.md, padding: 14, flexDirection: 'row', gap: 10, alignItems: 'center', borderWidth: 1, borderColor: msg.kind === 'err' ? C.danger : C.line }}>
        <Ionicons name={msg.kind === 'err' ? 'alert-circle' : 'checkmark-circle'} size={20} color={msg.kind === 'err' ? C.danger : C.good} />
        <Text style={{ color: C.text, flex: 1, fontWeight: '600' }}>{msg.text}</Text>
      </View>
    </Animated.View>
  );
}
