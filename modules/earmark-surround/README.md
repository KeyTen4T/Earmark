# earmark-surround

Local Expo module (Android only) that provides a native AC-3 (Dolby Digital) encoder for 5.1 PCM
and the audio sink that uses it, so a 5.1 book can reach a TV that only accepts surround as Dolby.

Task B built the encoder and its JNI wrapper. Task C added the sink and the renderers factory.

## Layout

```
expo-module.config.json                   autolinking entry (Android only)
android/build.gradle                      Gradle library, CMake, -O2, media3 compileOnly, JUnit
android/CMakeLists.txt                    builds libearmarksurround.so from the C sources
android/proguard-rules.pro                keeps app.earmark.surround.**
android/src/main/cpp/aften/               vendored aften 0.0.8 (see its README.md)
android/src/main/cpp/ac3enc.{c,h}         JNI-independent C API over aften
android/src/main/cpp/jni.c                JNI bridge for Ac3Encoder
android/src/main/java/app/earmark/surround/Ac3Encoder.kt
android/src/main/java/app/earmark/surround/PcmBlockBatcher.kt
android/src/main/java/app/earmark/surround/Ac3PassthroughAudioSink.kt
android/src/main/java/app/earmark/surround/SurroundRenderersFactory.kt
android/src/main/java/app/earmark/surround/EarmarkSurroundModule.kt
android/src/test/java/app/earmark/surround/PcmBlockBatcherTest.kt
test/roundtrip.sh, test/ac3enc_cli.c, test/analyze.py   host round-trip proof
```

## C API

* `ac3enc_open(sample_rate, channels, bitrate_kbps)` — 6 channels (5.1 + LFE) only; 48000 or
  44100 Hz; bitrate <= 0 means 640 kbps.
* `ac3enc_encode(handle, pcm_interleaved, out, out_cap)` — exactly 1536 frames of int16 PCM in
  Android/WAV order (FL, FR, FC, LFE, BL, BR); writes one complete AC-3 sync frame.
* `ac3enc_frame_bytes(handle)` — output frame size (constant 2560 bytes at 640 kbps / 48 kHz).
* `ac3enc_delay_frames(handle)` — encoder start-up delay, 256 samples; not compensated.
* `ac3enc_close(handle)`.

## Player path

`SurroundRenderersFactory` is a `DefaultRenderersFactory` whose `buildAudioSink` wraps the stock
`DefaultAudioSink` in `Ac3PassthroughAudioSink`. expo-audio is patched (see `patches/`) to build its
`ExoPlayer` with that factory by reflection when the class is present, and the stock builder
otherwise. The module therefore never gives expo-audio a Gradle dependency.

The sink decides in `configure`. It encodes only a 6-channel PCM16 48/44.1 kHz stream when the
output cannot play 6-channel PCM (the HDMI sink's PCM channel count is < 6), AC-3 5.1 passthrough is
available, and speed and pitch are 1.0. Everything else is forwarded untouched. Speed or pitch
changing away from 1.0 falls back to the plain PCM path. A failing encoder always falls back to
plain forwarding.

`EarmarkSurround.outputMode()` returns the chosen path (`"ac3"`, `"pcm"` or `"idle"`).
`EarmarkSurround.setSurroundEnabled(Boolean)` sets the process-wide choice the sink reads in
`decide()`; it defaults to true and takes effect at the next `configure()`. The app's `src/surround.ts`
calls both (safe no-ops when the module is absent, e.g. on web or desktop): the Settings → Playback
"Surround sound" choice sets the flag, and the player shows a "Dolby Digital 5.1" badge while
`outputMode()` is `"ac3"`.

## Tests

```
bash test/roundtrip.sh                                     # host encoder round trip (ffmpeg)
ANDROID_HOME=~/Android/Sdk ./gradlew :earmark-surround:testDebugUnitTest   # from android/
```

The JVM tests cover the pure block/timestamp/retry/padding logic in `PcmBlockBatcher` with a fake
encoder and writer; they need neither Android nor the native library. A device check of the AC-3
passthrough needs a TV that advertises AC-3 but not 6-channel PCM.
