import { test } from 'node:test';
import assert from 'node:assert/strict';
// The plugin is CommonJS; the pure manifest transform is off its default export.
import withAndroidTV from '../plugins/withAndroidTV.js';
const { applyAndroidTVManifest } = withAndroidTV as any;

// A parsed AndroidManifest in the xml2js shape prebuild hands the plugin.
const fixture = () => ({
  manifest: {
    $: { 'xmlns:android': 'http://schemas.android.com/apk/res/android' },
    'uses-permission': [{ $: { 'android:name': 'android.permission.INTERNET' } }],
    application: [{
      $: { 'android:name': '.MainApplication' },
      activity: [
        {
          $: { 'android:name': '.MainActivity', 'android:screenOrientation': 'portrait' },
          'intent-filter': [{
            action: [{ $: { 'android:name': 'android.intent.action.MAIN' } }],
            category: [{ $: { 'android:name': 'android.intent.category.LAUNCHER' } }],
          }],
        },
        {
          $: { 'android:name': '.OtherActivity' },
          'intent-filter': [{ action: [{ $: { 'android:name': 'android.intent.action.VIEW' } }] }],
        },
      ],
    }],
  },
});

test('android tv manifest: features, leanback category, banner and orientation, twice is once', () => {
  const m: any = fixture();
  applyAndroidTVManifest(m);
  applyAndroidTVManifest(m); // running twice must not duplicate anything

  const root = m.manifest;
  const features = root['uses-feature'];
  const named = (n: string) => features.filter((f: any) => f.$['android:name'] === n);
  assert.equal(named('android.software.leanback').length, 1);
  assert.equal(named('android.hardware.touchscreen').length, 1);
  assert.ok(features.every((f: any) => f.$['android:required'] === 'false'));

  assert.equal(root.application[0].$['android:banner'], '@drawable/tv_banner');

  const main = root.application[0].activity[0];
  const cats = main['intent-filter'][0].category.map((c: any) => c.$['android:name']);
  assert.ok(cats.includes('android.intent.category.LAUNCHER'));
  assert.equal(cats.filter((c: string) => c === 'android.intent.category.LEANBACK_LAUNCHER').length, 1);
  assert.equal(main.$['android:screenOrientation'], undefined);

  // The unrelated activity is left alone.
  assert.equal(root.application[0].activity[1].$['android:screenOrientation'], undefined);
  assert.equal(root.application[0].activity[1]['intent-filter'][0].category, undefined);
});

test('android tv manifest: an already-present feature is not added again', () => {
  const m: any = fixture();
  m.manifest['uses-feature'] = [{ $: { 'android:name': 'android.software.leanback', 'android:required': 'false' } }];
  applyAndroidTVManifest(m);
  assert.equal(m.manifest['uses-feature'].filter((f: any) => f.$['android:name'] === 'android.software.leanback').length, 1);
});
