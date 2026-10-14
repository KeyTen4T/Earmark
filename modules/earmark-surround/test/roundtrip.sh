#!/usr/bin/env bash
#
# Host round-trip test for the vendored aften AC-3 encoder and the ac3enc C API.
#
# It builds a small CLI (test/ac3enc_cli.c + ac3enc.c + the vendored libaften) with the host C
# compiler into a temp dir, generates a 6-second 5.1 test signal with ffmpeg (a distinct tone per
# channel, plus a short 5 kHz burst at 1 s in FL to measure the delay), encodes it to .ac3, decodes
# it back with ffmpeg and runs the signal checks in test/analyze.py.
#
# Nothing is written into the repository; all build products go to a mktemp dir.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CPP="$HERE/../android/src/main/cpp"

CC="${CC:-cc}"

for tool in ffmpeg ffprobe "$CC" python3; do
  command -v "$tool" >/dev/null 2>&1 || { echo "missing required tool: $tool" >&2; exit 127; }
done

TMP="$(mktemp -d "${TMPDIR:-/tmp}/earmark-ac3-roundtrip.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

echo "== building host encoder CLI =="
AFTEN_SRCS=(
  "$CPP/aften/a52enc.c"
  "$CPP/aften/bitalloc.c"
  "$CPP/aften/bitio.c"
  "$CPP/aften/crc.c"
  "$CPP/aften/dynrng.c"
  "$CPP/aften/window.c"
  "$CPP/aften/mdct.c"
  "$CPP/aften/exponent.c"
  "$CPP/aften/filter.c"
  "$CPP/aften/util.c"
)
"$CC" -O2 -std=gnu99 -DHAVE_CONFIG_H -I"$CPP" -I"$CPP/aften" \
  "$CPP/ac3enc.c" "${AFTEN_SRCS[@]}" "$HERE/ac3enc_cli.c" -lm -o "$TMP/ac3enc_cli"

echo "== generating 6 s 5.1 test input (tones 300/500/700/60/900/1100 Hz + burst in FL) =="
ffmpeg -y -v error \
  -f lavfi -i "aevalsrc=0.45*sin(2*PI*300*t)+0.5*sin(2*PI*5000*t)*between(t\,1.0\,1.002):s=48000:d=6" \
  -f lavfi -i "aevalsrc=0.5*sin(2*PI*500*t):s=48000:d=6" \
  -f lavfi -i "aevalsrc=0.5*sin(2*PI*700*t):s=48000:d=6" \
  -f lavfi -i "aevalsrc=0.5*sin(2*PI*60*t):s=48000:d=6" \
  -f lavfi -i "aevalsrc=0.5*sin(2*PI*900*t):s=48000:d=6" \
  -f lavfi -i "aevalsrc=0.5*sin(2*PI*1100*t):s=48000:d=6" \
  -filter_complex "[0:a][1:a][2:a][3:a][4:a][5:a]join=inputs=6:channel_layout=5.1:map=0.0-FL|1.0-FR|2.0-FC|3.0-LFE|4.0-BL|5.0-BR[a]" \
  -map "[a]" -f s16le -acodec pcm_s16le "$TMP/input.raw"

echo "== encoding =="
"$TMP/ac3enc_cli" "$TMP/input.raw" "$TMP/out.ac3" 2> "$TMP/enc.log" || { cat "$TMP/enc.log"; exit 1; }
cat "$TMP/enc.log"

frame_bytes="$(sed -n 's/^frame_bytes=//p' "$TMP/enc.log")"
delay_frames="$(sed -n 's/^delay_frames=//p' "$TMP/enc.log")"
[ -n "$frame_bytes" ] && [ -n "$delay_frames" ] || { echo "could not read encoder facts" >&2; exit 1; }

echo "== decoding with ffmpeg =="
ffmpeg -y -v error -i "$TMP/out.ac3" -ac 6 -f s16le -acodec pcm_s16le "$TMP/decoded.raw"

echo "== checks =="
python3 "$HERE/analyze.py" "$TMP/input.raw" "$TMP/decoded.raw" "$TMP/out.ac3" "$frame_bytes" "$delay_frames"
