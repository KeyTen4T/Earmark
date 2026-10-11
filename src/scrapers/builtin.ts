import type { ScraperDef } from './engine';

// Public-domain audiobooks read by LibriVox volunteers, hosted on the Internet Archive.
export const LIBRIVOX: ScraperDef = {
  id: 'librivox',
  name: 'LibriVox',
  version: 1,
  icon: '📚',
  description: 'Free public-domain audiobooks via the Internet Archive.',
  baseUrl: 'https://archive.org',
  type: 'json',
  search: {
    url:
      'https://archive.org/advancedsearch.php?q=collection%3Alibrivoxaudio+AND+%28{query|urlencode}%29' +
      '&fl%5B%5D=identifier&fl%5B%5D=title&fl%5B%5D=creator&fl%5B%5D=item_size&fl%5B%5D=runtime' +
      '&sort%5B%5D=downloads+desc&rows=40&page={page}&output=json',
  },
  results: {
    path: 'response.docs',
    fields: {
      title: '{title|clean}',
      author: '{creator|first}',
      cover: 'https://archive.org/services/img/{identifier}',
      size: '{item_size|bytes}',
      duration: '{runtime}',
      torrentUrl: 'https://archive.org/download/{identifier}/{identifier}_archive.torrent',
    },
  },
};

// The site changes domains often; when it moves, update baseUrl and search.url.
export const AUDIOBOOKBAY: ScraperDef = {
  id: 'audiobookbay',
  name: 'AudioBookBay',
  version: 2,
  icon: '🎧',
  description: 'AudioBookBay search. The magnet is fetched from the book page when you add a result.',
  baseUrl: 'https://audiobookbay.lu',
  type: 'html',
  search: { url: 'https://audiobookbay.lu/page/{page}/?s={query|lower|urlencode}' },
  results: {
    itemRegex:
      '<div class="post"><div class="postTitle"><h2><a href="(?<href>[^"]+)"[^>]*>(?<title>.*?)</a>.*?<div class=\'postMeta\'>',
    flags: 'gis',
    limit: 40,
    fields: {
      // Listing titles are "Title - Author"; split on the last " - ".
      title: '{title|clean|regex:^(.*) - ||title|clean}',
      author: '{title|clean|regex:^.* - (.*)$}',
      cover: '{item|regex:<img src="([^"]+)"}',
      size: '{item|regex:File Size: (<span[^>]*>[^<]*</span> [KMGT]?B)|clean}',
      detailUrl: '{href|abs}',
    },
  },
  detail: {
    regex: 'Info Hash:</td>\\s*<td>\\s*([0-9a-fA-F]{40})',
    trackerRegex: '<td>\\s*((?:udp|https?)://[^<\\s]+)\\s*</td>',
    fields: {
      infoHash: '{1|lower}',
      // The book page marks each reader as <span class="narrator">…</span>, linked to their other books.
      // Grab the whole "Read by" run and strip the links between the names.
      narrator: '{html|regex:Read by\\s*<a[^>]*>(.*?)<br\\s*/?>|clean}',
    },
  },
};

export const BUILTIN_SCRAPERS = [LIBRIVOX, AUDIOBOOKBAY];
