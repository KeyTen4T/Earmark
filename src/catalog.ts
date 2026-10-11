// General audiobook lookup, independent of the user's sources: Apple Books' audiobook catalogue.
// Free, no key. Docs: https://performance-partners.apple.com/search-api
// The same catalogue publishes best-seller charts, overall and per genre, which power Discover's browsing.
import { decodeEntities } from './scrapers/template';

export type CatalogBook = {
  id: string;
  title: string;
  author?: string;
  cover?: string;
  description?: string;
  genre?: string;
  year?: string;
  price?: string;
  url?: string; // the book's Apple Books page
  previewUrl?: string; // short audio sample
};

const plain = (html?: string) =>
  html ? decodeEntities(html.replace(/<br\s*\/?>|<\/p>/gi, '\n').replace(/<[^>]*>/g, '')).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim() : undefined;

const cleanTitle = (t: unknown) => String(t).replace(/\s*\((un)?abridged\)\s*$/i, '');
const bigCover = (url?: string) => (url ? String(url).replace(/\/\d+x\d+bb\./, '/600x600bb.') : undefined);

const fromSearch = (r: any): CatalogBook => ({
  id: String(r.collectionId),
  title: cleanTitle(r.collectionName),
  author: r.artistName,
  cover: bigCover(r.artworkUrl100),
  description: plain(r.description),
  genre: r.primaryGenreName,
  year: r.releaseDate ? String(r.releaseDate).slice(0, 4) : undefined,
  price: typeof r.collectionPrice === 'number' && r.currency === 'USD' ? `$${r.collectionPrice.toFixed(2)}` : undefined,
  url: r.collectionViewUrl,
  previewUrl: r.previewUrl,
});

export async function searchCatalog(query: string): Promise<CatalogBook[]> {
  const res = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(query)}&media=audiobook&entity=audiobook&limit=40`);
  if (!res.ok) throw new Error(`Catalogue search failed (HTTP ${res.status})`);
  const json = await res.json();
  return (json.results ?? []).filter((r: any) => r.collectionId && r.collectionName).map(fromSearch);
}

/** Full details for one book. Chart entries come without a description, so this fills it in. */
export async function lookupCatalog(id: string): Promise<CatalogBook | null> {
  const res = await fetch(`https://itunes.apple.com/lookup?id=${encodeURIComponent(id)}`);
  if (!res.ok) return null;
  const r = (await res.json()).results?.[0];
  return r?.collectionId ? fromSearch(r) : null;
}

// ---- Charts: what's selling right now, overall ('' id) or within one genre ----
export type Genre = { id: string; name: string };
export const GENRES: Genre[] = [
  { id: '', name: 'Popular' },
  { id: '50000040', name: 'Fiction' },
  { id: '50000055', name: 'Sci-Fi & Fantasy' },
  { id: '50000051', name: 'Mystery & Thriller' },
  { id: '50000069', name: 'Romance' },
  { id: '50000042', name: 'Biography' },
  { id: '50000049', name: 'History' },
  { id: '50000054', name: 'Science' },
  { id: '50000056', name: 'Self-Development' },
  { id: '50000043', name: 'Business' },
  { id: '50000046', name: 'Comedy' },
  { id: '50000045', name: 'Classics' },
  { id: '50000044', name: 'Kids & YA' },
  { id: '50000052', name: 'Nonfiction' },
  { id: '50000059', name: 'Travel & Adventure' },
];

const CHART_TTL_MS = 30 * 60 * 1000;
const chartCache = new Map<string, { at: number; books: CatalogBook[] }>();

/** The top 50 best-selling audiobooks, in chart order. Kept in memory for half an hour per genre. */
export async function topCharts(genreId = '', fetcher: typeof fetch = fetch): Promise<CatalogBook[]> {
  const hit = chartCache.get(genreId);
  if (hit && Date.now() - hit.at < CHART_TTL_MS) return hit.books;
  const res = await fetcher(`https://itunes.apple.com/us/rss/topaudiobooks/limit=50/genre=${genreId || '50000024'}/json`);
  if (!res.ok) throw new Error(`Couldn’t load the charts (HTTP ${res.status})`);
  const entry = (await res.json())?.feed?.entry;
  const books = (Array.isArray(entry) ? entry : entry ? [entry] : []).filter((e: any) => e?.id?.attributes?.['im:id']).map((e: any): CatalogBook => {
    const links = Array.isArray(e.link) ? e.link : e.link ? [e.link] : [];
    const images = Array.isArray(e['im:image']) ? e['im:image'] : [];
    return {
      id: String(e.id.attributes['im:id']),
      title: cleanTitle(e['im:name']?.label ?? e.title?.label ?? 'Untitled'),
      author: e['im:artist']?.label,
      cover: bigCover(images[images.length - 1]?.label),
      genre: e.category?.attributes?.label,
      year: e['im:releaseDate']?.label ? String(e['im:releaseDate'].label).slice(0, 4) : undefined,
      price: e['im:price']?.attributes?.currency === 'USD' ? e['im:price'].label : undefined,
      url: e.id.label,
      previewUrl: links.find((l: any) => l?.attributes?.rel === 'enclosure')?.attributes?.href,
    };
  });
  chartCache.set(genreId, { at: Date.now(), books });
  return books;
}
