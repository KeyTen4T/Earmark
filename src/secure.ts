// Where API keys are kept. On Android that's the encrypted keystore (expo-secure-store). The desktop
// build has no such module, so it hands keys to the Electron shell, which encrypts them with the
// system keyring; a plain browser falls back to local storage.
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

type Bridge = { get(k: string): Promise<string | null>; set(k: string, v: string): Promise<void>; delete(k: string): Promise<void> };
const bridge = (): Bridge | undefined => (globalThis as any).earmarkDesktop?.secret;
const web = Platform.OS === 'web';

export async function getSecret(key: string): Promise<string | null> {
  if (!web) return SecureStore.getItemAsync(key);
  const b = bridge();
  return b ? b.get(key) : globalThis.localStorage?.getItem(`secret:${key}`) ?? null;
}

export async function setSecret(key: string, value: string): Promise<void> {
  if (!web) return SecureStore.setItemAsync(key, value);
  const b = bridge();
  if (b) await b.set(key, value);
  else globalThis.localStorage?.setItem(`secret:${key}`, value);
}

export async function deleteSecret(key: string): Promise<void> {
  if (!web) return SecureStore.deleteItemAsync(key);
  const b = bridge();
  if (b) await b.delete(key);
  else globalThis.localStorage?.removeItem(`secret:${key}`);
}
