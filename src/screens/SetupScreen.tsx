import React, { useState } from 'react';
import { View, Text, TextInput, KeyboardAvoidingView, Platform, Linking } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { C, R, T } from '../theme';
import { Button } from '../components/ui';
import { verifyKey } from '../torbox';
import { setApiKey } from '../storage';

export function SetupScreen({ onDone }: { onDone: (key: string) => void }) {
  const insets = useSafeAreaInsets();
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const save = async () => {
    const k = key.trim();
    if (!k) return;
    setBusy(true); setErr('');
    try {
      await verifyKey(k);
      await setApiKey(k);
      onDone(k);
    } catch (e: any) {
      setErr(e.message ?? 'That key did not work');
    } finally { setBusy(false); }
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, backgroundColor: C.bg }}>
      <LinearGradient colors={['#3B1F0A', '#1A0F1F', C.bg]} locations={[0, 0.45, 1]} style={{ position: 'absolute', left: 0, right: 0, top: 0, height: 520 }} />
      <View style={{ flex: 1, paddingHorizontal: 24, paddingTop: insets.top + 64, paddingBottom: insets.bottom + 24, justifyContent: 'space-between' }}>
        <View>
          <LinearGradient colors={[C.accent, C.accentDeep]} style={{ width: 84, height: 84, borderRadius: 26, alignItems: 'center', justifyContent: 'center', marginBottom: 28 }}>
            <Ionicons name="headset" size={44} color={C.accentInk} />
          </LinearGradient>
          <Text style={[T.hero, { fontSize: 44 }]}>Earmark</Text>
          <Text style={[T.body, { fontSize: 17, lineHeight: 25, marginTop: 10, color: C.sub }]}>
            Your audiobooks, streamed straight from TorBox. No downloads, no waiting.
          </Text>
        </View>

        <View style={{ gap: 14 }}>
          <Text style={T.label}>TorBox API key</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: C.surface, borderRadius: R.md, borderWidth: 1, borderColor: err ? C.danger : C.line, paddingHorizontal: 14 }}>
            <Ionicons name="key-outline" size={18} color={C.faint} />
            <TextInput
              value={key} onChangeText={setKey} placeholder="Paste your key" placeholderTextColor={C.faint} accessibilityLabel="TorBox API key"
              autoCapitalize="none" autoCorrect={false} secureTextEntry onSubmitEditing={save}
              style={{ flex: 1, color: C.text, height: 54, marginLeft: 10, fontSize: 15 }}
            />
          </View>
          {err ? <Text style={{ color: C.danger }}>{err}</Text> : null}
          <Button label="Continue" icon="arrow-forward" onPress={save} loading={busy} disabled={!key.trim()} />
          <Text onPress={() => Linking.openURL('https://torbox.app/settings')} style={[T.small, { textAlign: 'center', marginTop: 4 }]}>
            Find it at torbox.app → Settings → API. It stays on this device.
          </Text>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}
