# Writing scrapers for Earmark

A scraper is a `.json` file that tells Earmark how to search a website or API and turn its results into something TorBox can add. Import one from **Settings → Sources** with **Import .json** (you can pick several files at once), a URL, or by pasting it.

A file can hold one scraper, an array of scrapers, or `{ "scrapers": [ ... ] }`. Re-importing a scraper with the same `id` replaces the old one.

Earmark also imports **`provider.json` search sources** (files with `schemaVersion` and `adapters.search`, as made by source builders like Forge & Fable) and converts them to a scraper. Ebook rows are skipped, and direct archive.org file links are added through the item's archive.org torrent. Direct links to other sites can't go through TorBox, so they're left out. Results whose torrent is over 40 GB are refused when you add them, since that's a collection, not a book.

## Top-level keys

| Key | Required | Meaning |
|---|---|---|
| `id` | yes | Unique id. Can't reuse a built-in id (`librivox`, `audiobookbay`). |
| `name` | yes | Shown in the app. |
| `type` | yes | `"json"` for APIs, `"html"` for web pages read with a regex. |
| `search.url` | yes | Search URL. Must contain `{query}` (here or in `search.body`). `{page}` and `{page0}` are also available. |
| `search.method` / `headers` / `body` | no | For POST APIs or APIs that need headers. |
| `results.fields` | yes | How to build each result (below). |
| `results.path` | json | Dot path to the array of results, e.g. `"data.items"`. Empty means the response itself is the array. |
| `results.itemRegex` | html | Regex matched repeatedly against the page. Each match is one result. |
| `results.flags` | no | Regex flags for `itemRegex`, default `gi`. Add `s` so `.` matches newlines. |
| `results.limit` | no | Max results, default 50. |
| `results.where` | no | Template; results where it renders empty are skipped, e.g. `"{format\|regex:^(mp3\|m4b)$}"`. |
| `detail` | no | Second request per result, made only when the user adds it. |
| `rateLimit` | no | `{ "requestsPerMinute": 10, "retryAfterMs": 6000 }`. Earmark refuses searches past the per-minute limit and retries once after `retryAfterMs` on HTTP 429. Copied from a `provider.json` automatically. |
| `baseUrl` | no | Used by the `abs` filter to make relative links absolute. |
| `icon`, `description`, `version` | no | Cosmetic. |

## Result fields

`title` is required. Each result also needs **one** way to get the torrent:

- `magnet`: a magnet link
- `infoHash`: a 40-character hex info hash
- `torrentUrl`: a link to a `.torrent` file (Earmark downloads it and computes the magnet itself)
- `detailUrl` plus a `detail` block: open a page and pull one of the above out of it

Optional display fields: `author`, `narrator`, `cover` (image URL), `size`, `seeders`, `duration`.

Results with a magnet or info hash are checked against TorBox's cache and get an **INSTANT** badge when TorBox already has them.

## Templates

Every field value is a template. `{name}` inserts a value. In JSON scrapers that's a key of the result object, and dot paths work (`{author.name}`, `{files.0.url}`). In HTML scrapers it's a regex group: numbered `{1}`, `{2}`, or named `(?<title>...)` → `{title}`. `{item}` is the whole match.

Filters chain with `|`:

| Filter | Does |
|---|---|
| `urlencode` | Encode for a URL, use on `{query}` |
| `clean` | Strip tags, decode entities, collapse whitespace |
| `striptags`, `decode`, `trim`, `lower`, `upper` | What they say |
| `bytes` | `524288000` → `500.0 MB` |
| `first` | First item of an array |
| `join:, ` | Join an array with a separator |
| `abs` | Make a relative URL absolute using `baseUrl` |
| `default:text` | Use `text` when empty |
| `replace:from=>to` | Plain text replace |
| `regex:pattern` | First capture group of `pattern` (pattern can't contain `|`, `{` or `}`) |
| `json` | Escape for inside a JSON string, use on `{query}` in a POST body: `{{"q": "{query\|json}"}}` |
| `iatorrent` | archive.org file or item URL → that item's `_archive.torrent` URL |

`{a||b}` uses `b` when `a` is empty. `{'text'}` is a literal. `{{` and `}}` produce literal braces.

## The detail step

```json
"detail": {
  "url": "{detailUrl}",
  "type": "html",
  "regex": "href=\"(magnet:\\?[^\"]+)\"",
  "fields": { "magnet": "{1|decode}" }
}
```

Add `"trackerRegex"` (html only) when the page gives an info hash and lists its trackers: every match's first group is added to the magnet as a tracker. Without trackers TorBox often can't find the torrent.

For `"type": "json"` the response's keys become variables instead of regex groups. Fields can be `magnet`, `infoHash` or `torrentUrl`. All of the search result's variables are still available.

## Examples

See `scrapers/` in this project: `archive-org-audio.json` (JSON API) and `TEMPLATE-html.json` (regex + detail page).

## Tips

- In JSON, backslashes in regexes must be doubled: `\\d+`.
- If a source errors, Discover shows its message under the search bar. "HTTP 403" usually means the site blocks non-browser requests.
- Regex on HTML is fragile. When a site changes its layout, update the regex and re-import.
