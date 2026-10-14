#!/usr/bin/env python3
"""Signal checks for the AC-3 round-trip test.

Usage:
  analyze.py <input.raw> <decoded.raw> <out.ac3> <frame_bytes> <delay_frames>

<input.raw> and <decoded.raw> are raw interleaved s16le 6-channel 48 kHz PCM in Android/WAV
order (FL, FR, FC, LFE, BL, BR).

Checks, all of which must pass:
  * ffprobe says ac3 / 6 channels / 5.1(side) / 48000 Hz
  * every decoded channel is dominated by the frequency that was encoded in it
  * the decoded length is within one AC-3 frame of the input length
  * the measured input->output delay (a burst cross-correlation) is reported and compared with
    ac3enc_delay_frames()

Prints a short PASS/FAIL table and exits non-zero if any row fails.

numpy is used when available (precise FFT peak); a pure-Python fallback using the Goertzel
algorithm at the known candidate frequencies and an absolute-peak burst search is used otherwise.
"""
import json
import math
import subprocess
import sys

FS = 48000
CHANNELS = 6
EXPECTED_FREQS = [300, 500, 700, 60, 900, 1100]  # FL, FR, FC, LFE, BL, BR


def read_s16le(path):
    with open(path, "rb") as f:
        data = f.read()
    if len(data) % 2:
        raise SystemExit(f"{path}: odd byte count")
    import array
    a = array.array("h")
    a.frombytes(data)
    if sys.byteorder == "big":
        a.byteswap()
    return a


def deinterleave(samples):
    chans = [samples[c::CHANNELS] for c in range(CHANNELS)]
    return chans


def ffprobe_stream(path):
    try:
        out = subprocess.check_output([
            "ffprobe", "-v", "error", "-select_streams", "a:0",
            "-show_entries", "stream=codec_name,channels,channel_layout,sample_rate",
            "-of", "json", path,
        ])
    except FileNotFoundError:
        raise SystemExit("ffprobe not found")
    except subprocess.CalledProcessError as e:
        raise SystemExit(f"ffprobe failed on {path}: {e}")
    streams = json.loads(out).get("streams", [])
    if not streams:
        raise SystemExit(f"ffprobe found no audio stream in {path}")
    return streams[0]


def try_numpy():
    import os
    if os.environ.get("AC3ENC_NO_NUMPY") == "1":
        return None
    try:
        import numpy as np
        return np
    except ImportError:
        return None


def dominant_freq_numpy(np, samples):
    x = np.asarray(samples, dtype=np.float64)
    # ignore 100 ms at each end to avoid codec edges
    edge = FS // 10
    if len(x) > 4 * edge:
        x = x[edge:-edge]
    x = x - x.mean()
    n = len(x)
    win = np.hanning(n)
    spec = np.abs(np.fft.rfft(x * win))
    freqs = np.fft.rfftfreq(n, 1.0 / FS)
    peak = int(np.argmax(spec[1:]) + 1)
    return float(freqs[peak])


def goertzel(samples, freq, fs, step=4):
    """Plain-Python Goertzel magnitude at one frequency (decimated by `step` for speed).

    The digital frequency must use the *decimated* rate, otherwise every result is scaled.
    Tones above ~6 kHz are absent from the checks and the 5 kHz burst stays below the 12 kHz
    decimated Nyquist, so a step of 4 does not alias into any candidate.
    """
    w = 2.0 * math.pi * freq / (fs / step)
    c = 2.0 * math.cos(w)
    s0 = s1 = s2 = 0.0
    n = 0
    for i in range(0, len(samples), step):
        s0 = (samples[i] / 32768.0) + c * s1 - s2
        s2 = s1
        s1 = s0
        n += 1
    # magnitude of the DFT bin
    return math.hypot(s1 - s2 * math.cos(w), s2 * math.sin(w)) / max(n, 1)


def dominant_freq_goertzel(channel):
    mags = {f: goertzel(channel, f, FS, step=8) for f in EXPECTED_FREQS}
    return max(mags, key=mags.get), mags


def bandpass_numpy(np, samples, lo, hi):
    x = np.asarray(samples, dtype=np.float64)
    spec = np.fft.rfft(x)
    freqs = np.fft.rfftfreq(len(x), 1.0 / FS)
    spec[(freqs < lo) | (freqs > hi)] = 0
    return np.fft.irfft(spec, n=len(x))


def measure_delay_numpy(np, ref, dec):
    # Keep only the >2.5 kHz band, where only the 1 s burst lives (the tones are all <=1.1 kHz).
    a = bandpass_numpy(np, ref, 2500, 12000)
    b = bandpass_numpy(np, dec, 2500, 12000)
    n = min(len(a), len(b))
    a = a[:n]
    b = b[:n]
    if n == 0:
        return None
    n2 = 1 << (2 * n - 1).bit_length()
    cc = np.fft.irfft(np.fft.rfft(a, n2) * np.conj(np.fft.rfft(b, n2)), n2)
    lags = np.arange(n2)
    lags[lags > n2 // 2] -= n2
    # cc[l] = sum_n a[n] b[n-l], so a b delayed by d peaks at l = -d; negate to report the delay.
    mask = (lags >= -2048) & (lags <= 256)
    best = int(np.argmax(cc[mask]))
    return -int(lags[mask][best])


def measure_delay_plain(ref, dec):
    """Windowed cross-correlation of the first differences around the 1 s 5 kHz burst."""
    def diff(x):
        return [x[i + 1] - x[i] for i in range(len(x) - 1)]

    d_ref = diff(ref)
    d_dec = diff(dec)

    # rough burst location: largest first difference in the 1..2 s window
    lo, hi = FS, min(2 * FS, len(d_ref))
    ri = max(range(lo, hi), key=lambda i: abs(d_ref[i]))

    w = 2000
    base = ri - w
    a = d_ref[base:ri + w]
    best_lag, best = 0, -1.0
    for lag in range(0, 600):
        b0 = base + lag
        if b0 < 0 or b0 + len(a) > len(d_dec):
            break
        s = 0.0
        for i in range(len(a)):
            s += a[i] * d_dec[b0 + i]
        if s > best:
            best, best_lag = s, lag
    return best_lag


def main():
    if len(sys.argv) != 6:
        raise SystemExit(__doc__)
    in_path, dec_path, ac3_path = sys.argv[1:4]
    frame_bytes = int(sys.argv[4])
    delay_frames = int(sys.argv[5])

    np = try_numpy()

    inp = deinterleave(read_s16le(in_path))
    dec = deinterleave(read_s16le(dec_path))

    rows = []  # (name, ok, detail)

    # --- ffprobe ---
    st = ffprobe_stream(ac3_path)
    codec = st.get("codec_name", "")
    chans = int(st.get("channels", 0))
    layout = st.get("channel_layout", "")
    rate = int(st.get("sample_rate", 0))
    rows.append(("ffprobe codec=ac3", codec == "ac3", codec))
    rows.append(("ffprobe channels=6", chans == 6, str(chans)))
    rows.append(("ffprobe layout 5.1|5.1(side)", layout in ("5.1", "5.1(side)"), layout))
    rows.append(("ffprobe rate=48000", rate == FS, str(rate)))

    # --- channel mapping ---
    freq_ok = True
    freq_detail = []
    for i, expected in enumerate(EXPECTED_FREQS):
        chan = dec[i] if i < len(dec) else []
        if np is not None:
            found = dominant_freq_numpy(np, chan)
            ok = abs(found - expected) <= 25.0
        else:
            found, mags = dominant_freq_goertzel(chan)
            own = mags[expected]
            others = [m for f, m in mags.items() if f != expected]
            ok = found == expected and own > 3.0 * max(others)
            found = f"{found} Hz (goertzel)"
        freq_ok = freq_ok and ok
        freq_detail.append(f"ch{i}={found} exp={expected}{'' if ok else ' FAIL'}")
    rows.append(("channel mapping", freq_ok, "; ".join(freq_detail)))

    # --- length within one frame ---
    in_frames = len(inp[0])
    dec_frames = len(dec[0])
    diff = abs(dec_frames - in_frames)
    rows.append(("length within one frame", diff <= 1536,
                 f"in={in_frames} out={dec_frames} diff={diff}"))

    # --- delay ---
    measured = None
    if len(inp[0]) > 0 and len(dec[0]) > 0:
        if np is not None:
            measured = measure_delay_numpy(np, inp[0], dec[0])
        else:
            measured = measure_delay_plain(inp[0], dec[0])
    delay_ok = measured is not None and abs(measured - delay_frames) <= 32
    rows.append(("measured delay ~= ac3enc_delay_frames",
                 delay_ok,
                 f"measured={measured} reported={delay_frames}"))

    # --- table ---
    width = max(len(name) for name, _, _ in rows)
    print(f"{'CHECK':<{width}}  RESULT  DETAIL")
    all_ok = True
    for name, ok, detail in rows:
        all_ok = all_ok and ok
        print(f"{name:<{width}}  {'PASS' if ok else 'FAIL':<6}  {detail}")
    print(f"frame_bytes={frame_bytes} delay_frames={delay_frames} numpy={'yes' if np is not None else 'no'}")
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
