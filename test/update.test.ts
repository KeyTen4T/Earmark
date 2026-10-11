import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, parseRelease, updateAvailable, shouldAutoCheck, summary } from '../src/update-check';

// A trimmed GitHub `releases/latest` payload, kept exactly as the API returns it.
const FIXTURE = JSON.parse(`{
  "tag_name": "v1.4.0",
  "name": "Earmark 1.4.0",
  "body": "## What's new\\n\\n**Faster** startup\\n- Fixed a crash when resuming\\nUse \`Settings\` to check\\n\\nThanks for listening!",
  "draft": false,
  "prerelease": false,
  "html_url": "https://github.com/KeyTen4T/Earmark/releases/tag/v1.4.0",
  "assets": [
    { "name": "Earmark-1.4.0.apk", "browser_download_url": "https://github.com/KeyTen4T/Earmark/releases/download/v1.4.0/Earmark-1.4.0.apk" },
    { "name": "Earmark-1.4.0.AppImage", "browser_download_url": "https://github.com/KeyTen4T/Earmark/releases/download/v1.4.0/Earmark-1.4.0.AppImage" },
    { "name": "earmark-desktop_1.4.0_amd64.deb", "browser_download_url": "https://github.com/KeyTen4T/Earmark/releases/download/v1.4.0/earmark-desktop_1.4.0_amd64.deb" },
    { "name": "checksums.txt", "browser_download_url": "https://github.com/KeyTen4T/Earmark/releases/download/v1.4.0/checksums.txt" }
  ]
}`);

test('update: parseRelease reads the version, notes and asset URLs', () => {
  const r = parseRelease(FIXTURE);
  assert.ok(r);
  assert.equal(r!.version, '1.4.0');
  assert.match(r!.notes, /Faster/);
  assert.equal(r!.pageUrl, 'https://github.com/KeyTen4T/Earmark/releases/tag/v1.4.0');
  assert.equal(r!.apkUrl, 'https://github.com/KeyTen4T/Earmark/releases/download/v1.4.0/Earmark-1.4.0.apk');
  assert.equal(r!.debUrl, 'https://github.com/KeyTen4T/Earmark/releases/download/v1.4.0/earmark-desktop_1.4.0_amd64.deb');
  assert.equal(r!.appImageUrl, 'https://github.com/KeyTen4T/Earmark/releases/download/v1.4.0/Earmark-1.4.0.AppImage');
});

test('update: parseRelease rejects drafts, prereleases, bad tags and wrong shapes', () => {
  assert.equal(parseRelease({ ...FIXTURE, draft: true }), null);
  assert.equal(parseRelease({ ...FIXTURE, prerelease: true }), null);
  assert.equal(parseRelease({ ...FIXTURE, tag_name: 'nightly' }), null);
  assert.equal(parseRelease({ ...FIXTURE, tag_name: 'v1.4' }), null);
  assert.equal(parseRelease({ ...FIXTURE, html_url: undefined }), null);
  assert.equal(parseRelease({ ...FIXTURE, assets: 'nope' }), null);
  assert.equal(parseRelease(null), null);
  assert.equal(parseRelease(undefined), null);
  assert.equal(parseRelease('nope'), null);
});

test('update: parseRelease tolerates a release with no assets', () => {
  const r = parseRelease({ tag_name: 'v2.0.0', html_url: 'https://example/release', body: '', assets: [] });
  assert.equal(r?.version, '2.0.0');
  assert.equal(r?.apkUrl, undefined);
  assert.equal(r?.debUrl, undefined);
  assert.equal(r?.appImageUrl, undefined);
});

test('update: compareVersions orders X.Y.Z with an optional v and pre-release', () => {
  assert.equal(compareVersions('1.3.5', '1.3.5'), 0);
  assert.equal(compareVersions('v1.3.5', '1.3.5'), 0);
  assert.equal(compareVersions('1.3.4', '1.3.5'), -1);
  assert.equal(compareVersions('1.3.10', '1.3.9'), 1);
  assert.equal(compareVersions('1.3.0', '1.3.0-beta.6'), 1); // a release beats its prereleases
  assert.equal(compareVersions('1.3.0-beta.6', '1.3.0'), -1);
  assert.equal(compareVersions('1.3.0-beta.6', '1.3.0-beta.11'), -1); // numeric identifiers compare as numbers
  assert.equal(compareVersions('1.3.0-alpha', '1.3.0-beta'), -1);
});

test('update: compareVersions never throws on garbage', () => {
  assert.equal(compareVersions('nonsense', 'nonsense'), 0);
  assert.equal(compareVersions('', '1.0.0'), -1);
  assert.equal(compareVersions('1.0.0', 'not-a-version'), 1);
  assert.equal(compareVersions(undefined as any, 'x' as any), 0);
});

test('update: updateAvailable is true only for a strictly newer release', () => {
  const r = parseRelease(FIXTURE)!;
  assert.equal(updateAvailable('1.3.5', r), true);
  assert.equal(updateAvailable('1.4.0', r), false);
  assert.equal(updateAvailable('1.4.1', r), false);
  assert.equal(updateAvailable('1.3.5', null), false);
});

test('update: shouldAutoCheck throttles to 24 hours', () => {
  const now = 1_000_000_000_000;
  assert.equal(shouldAutoCheck(0, now), true);
  assert.equal(shouldAutoCheck(null, now), true);
  assert.equal(shouldAutoCheck(now - 60_000, now), false);
  assert.equal(shouldAutoCheck(now - 24 * 60 * 60 * 1000, now), false);
  assert.equal(shouldAutoCheck(now - 24 * 60 * 60 * 1000 - 1, now), true);
});

test('update: summary strips markdown markers and keeps the first lines', () => {
  assert.deepEqual(summary(FIXTURE.body, 6).split('\n'),
    ["What's new", 'Faster startup', 'Fixed a crash when resuming', 'Use Settings to check', 'Thanks for listening!']);
  assert.equal(summary(FIXTURE.body, 2), "What's new\nFaster startup");
  assert.equal(summary('a\n\n\nb', 6), 'a\nb');
  assert.equal(summary('', 6), '');
  assert.equal(summary(42, 6), '');
  assert.equal(summary('a', 0), '');
});
