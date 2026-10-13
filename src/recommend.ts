// Personal "Surprise me" picks: sends the listener's history and a list of candidate books to an AI
// service the user has a key for, and gets back which candidate to suggest and why.
// The provider is recognised from the key itself, so Settings needs only one field.
import { fetchWithTimeout } from './fetch-timeout';

export type AiProvider = 'gemini' | 'groq' | 'xai';
export type HistoryItem = { title: string; author?: string; status: 'finished' | 'listening' | 'not started' | 'wants to listen'; percent?: number };
export type Candidate = { id: string; title: string; author?: string; genre?: string };
export type Recommendation = { id: string; reason: string };

const PROVIDERS: Record<AiProvider, { name: string; base: string; prefer: RegExp[] }> = {
  gemini: { name: 'Gemini', base: 'https://generativelanguage.googleapis.com/v1beta', prefer: [/^gemini-flash-latest$/, /^gemini-[\d.]+-flash$/, /^gemini-.*flash/] },
  groq: { name: 'Groq', base: 'https://api.groq.com/openai/v1', prefer: [/llama-3\.3-70b/, /llama.*70b/, /llama/] },
  xai: { name: 'Grok', base: 'https://api.x.ai/v1', prefer: [/^grok-[\d.]+-fast(?!.*reason)/, /^grok-[\d.]+$/, /^grok/] },
};
export const providerName = (p: AiProvider) => PROVIDERS[p].name;

/** Strips what tends to come along with a pasted key: spaces, line breaks, quotes, a "Bearer " prefix. */
export const cleanKey = (key: string) => key.replace(/^\s*bearer\s+/i, '').replace(/[\s"'`]+/g, '');

/**
 * Groq and Grok keys have fixed prefixes. Google's don't (older ones start "AIza", newer ones differ),
 * so anything else is treated as a Gemini key and Google gets to say whether it's valid.
 */
export function providerFor(key: string): AiProvider | null {
  const k = cleanKey(key);
  if (!k) return null;
  if (/^gsk_/.test(k)) return 'groq';
  if (/^xai-/.test(k)) return 'xai';
  return 'gemini';
}

type Fetcher = typeof fetch;

async function getJson(fetcher: Fetcher, url: string, init: RequestInit, who: string) {
  let res: Response;
  // An AI reply can take a while to generate, so this limit is deliberately longer than a plain API.
  try { res = await fetchWithTimeout(url, init, 60_000, fetcher); } catch { throw new Error(`Could not reach ${who}. Check your connection.`); }
  const json: any = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 || res.status === 403 || /API key not valid/i.test(json?.error?.message ?? '')) throw new Error(`${who} rejected that API key.`);
    if (res.status === 429) throw new Error(`${who} says you’ve hit its usage limit. Try again in a minute.`);
    throw new Error(json?.error?.message ?? `${who} error (HTTP ${res.status})`);
  }
  return json;
}

// The key goes in a header, never in the URL.
const authHeaders = (p: AiProvider, key: string): Record<string, string> =>
  p === 'gemini' ? { 'x-goog-api-key': key } : { Authorization: `Bearer ${key}` };

const modelCache = new Map<string, string>();

/** Asks the service which models the key can use and picks a fast general one. Doubles as the key check. */
export async function pickModel(rawKey: string, fetcher: Fetcher = fetch): Promise<{ provider: AiProvider; model: string }> {
  const key = cleanKey(rawKey);
  const provider = providerFor(key);
  if (!provider) throw new Error('Paste an API key first.');
  const cached = modelCache.get(key);
  if (cached) return { provider, model: cached };
  const { base, prefer, name } = PROVIDERS[provider];
  const json = await getJson(fetcher, `${base}/models${provider === 'gemini' ? '?pageSize=200' : ''}`, { headers: authHeaders(provider, key) }, name);
  const ids: string[] = provider === 'gemini'
    ? (json?.models ?? []).filter((m: any) => (m.supportedGenerationMethods ?? []).includes('generateContent')).map((m: any) => String(m.name).replace(/^models\//, ''))
    : (json?.data ?? []).map((m: any) => String(m.id));
  const usable = ids.filter((id) => !/embed|whisper|tts|guard|image|vision-preview|audio|live/i.test(id));
  const model = prefer.map((re) => usable.find((id) => re.test(id))).find(Boolean) ?? usable[0];
  if (!model) throw new Error(`${name} didn’t list any model this key can use.`);
  modelCache.set(key, model);
  return { provider, model };
}

function buildPrompt(history: HistoryItem[], candidates: Candidate[], avoid: string[]) {
  const line = (h: HistoryItem) =>
    `- ${h.title}${h.author ? ` by ${h.author}` : ''} (${h.status}${h.status === 'listening' && h.percent != null ? `, ${Math.round(h.percent)}% through` : ''})`;
  return [
    'You recommend audiobooks. Choose exactly ONE book from CANDIDATES that this listener is most likely to love, judging by HISTORY.',
    'Finished books and ones they are far into show what they like; books barely started and abandoned count for less.',
    'Never choose a book that is already in HISTORY, or another edition of one. Prefer something a little unexpected over the most obvious choice.',
    avoid.length ? `Do not choose any of these ids, they were just suggested: ${avoid.join(', ')}.` : '',
    'Answer with JSON only: {"id": "<candidate id>", "reason": "<one or two warm sentences to the listener saying why, naming a book from their history it connects to>"}',
    '',
    'HISTORY:',
    history.length ? history.slice(0, 80).map(line).join('\n') : '(nothing yet)',
    '',
    'CANDIDATES:',
    candidates.map((c) => `${c.id} | ${c.title}${c.author ? ` | ${c.author}` : ''}${c.genre ? ` | ${c.genre}` : ''}`).join('\n'),
  ].filter((l, i) => l !== '' || i > 3).join('\n');
}

/** Picks one candidate for this listener. Throws with a readable message if the service fails or answers nonsense. */
export async function recommend(key: string, history: HistoryItem[], candidates: Candidate[], avoid: string[] = [], fetcher: Fetcher = fetch): Promise<Recommendation> {
  if (!candidates.length) throw new Error('Nothing to choose from');
  key = cleanKey(key);
  const { provider, model } = await pickModel(key, fetcher);
  const { base, name } = PROVIDERS[provider];
  const prompt = buildPrompt(history, candidates, avoid);
  const headers = { 'Content-Type': 'application/json', ...authHeaders(provider, key) };
  let text: string;
  if (provider === 'gemini') {
    const json = await getJson(fetcher, `${base}/models/${model}:generateContent`, {
      method: 'POST', headers,
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 1, responseMimeType: 'application/json' } }),
    }, name);
    text = (json?.candidates?.[0]?.content?.parts ?? []).map((p: any) => p?.text ?? '').join('');
  } else {
    const json = await getJson(fetcher, `${base}/chat/completions`, {
      method: 'POST', headers,
      body: JSON.stringify({ model, temperature: 1, response_format: { type: 'json_object' }, messages: [{ role: 'user', content: prompt }] }),
    }, name);
    text = json?.choices?.[0]?.message?.content ?? '';
  }
  const m = /\{[\s\S]*\}/.exec(text);
  let out: any = null;
  try { out = m ? JSON.parse(m[0]) : null; } catch { /* handled below */ }
  const id = String(out?.id ?? '').trim();
  if (!candidates.some((c) => c.id === id)) throw new Error(`${name} didn’t pick a book from the list. Try again.`);
  return { id, reason: String(out?.reason ?? '').trim() };
}
