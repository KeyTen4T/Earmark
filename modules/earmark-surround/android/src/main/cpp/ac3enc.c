/*
 * ac3enc.c - thin C API over the vendored aften 0.0.8 encoder.
 *
 * Channel order
 * -------------
 * The input is Android/WAV order: FL, FR, FC, LFE, BL, BR. aften's encoder expects its own
 * internal A/52 order (L, C, R, SL, SR, LFE) and, unlike the aften command-line tool, does *not*
 * remap on its own. We therefore call aften_remap_wav_to_a52() exactly once per frame, on a
 * private copy of the input, which is the only remap in the pipeline.
 *
 * Delay
 * -----
 * aften keeps the last 256 samples of the previous frame as the first 256 samples of the next
 * block-0 MDCT window (last_samples, zero-filled at init). The output is therefore delayed by 256
 * samples; aften_encode_frame(..., NULL) does not flush it. We expose that number and do not
 * compensate for it here.
 */
#include "ac3enc.h"

#include <stdlib.h>
#include <string.h>

#include "aften/aften.h"

/* Verified against the aften 0.0.8 source and measured by the round-trip test: a52enc.c
 * copy_samples() prepends 256 zero samples from ctx->last_samples on the first frame. */
#define AC3ENC_DELAY_FRAMES 256

struct Ac3Encoder {
    AftenContext ctx;
    /* Private, mutable copy of one frame of WAV-order int16 samples, remapped in place. */
    int16_t pcm[AC3ENC_SAMPLES_PER_FRAME * AC3ENC_CHANNELS];
    int sample_rate;
    int channels;
    int bitrate_kbps;
    int frame_bytes;
};

static int
is_valid_sample_rate(int sample_rate)
{
    return sample_rate == 48000 || sample_rate == 44100;
}

Ac3Encoder *
ac3enc_open(int sample_rate, int channels, int bitrate_kbps)
{
    Ac3Encoder *enc;

    if (!is_valid_sample_rate(sample_rate)) return NULL;
    if (channels != AC3ENC_CHANNELS) return NULL;
    if (bitrate_kbps <= 0) bitrate_kbps = 640;

    enc = (Ac3Encoder *)calloc(1, sizeof(*enc));
    if (enc == NULL) return NULL;

    enc->sample_rate = sample_rate;
    enc->channels = channels;
    enc->bitrate_kbps = bitrate_kbps;

    aften_set_defaults(&enc->ctx);
    enc->ctx.verbose = 0;
    enc->ctx.channels = channels;
    enc->ctx.acmod = A52_ACMOD_3_2; /* 5 full-band channels */
    enc->ctx.lfe = 1;
    enc->ctx.samplerate = sample_rate;
    enc->ctx.sample_format = A52_SAMPLE_FMT_S16;
    enc->ctx.params.encoding_mode = AFTEN_ENC_MODE_CBR;
    enc->ctx.params.bitrate = bitrate_kbps;
    /* Single-threaded: threading.h falls back to NO_THREADS when no threading macro is set, and
     * we also pin n_threads to 1 so a build that did define one would still not spawn workers. */
    enc->ctx.system.n_threads = 1;

    if (aften_encode_init(&enc->ctx) != 0) {
        free(enc);
        return NULL;
    }

    /* Nominal frame size in 16-bit words, same arithmetic as aften's frame_size_min. At 44.1 kHz
     * CBR frames can be one word larger to hit the average bitrate, so report the larger size. */
    enc->frame_bytes = ((bitrate_kbps * 96000) / sample_rate) * 2;
    if (sample_rate == 44100) enc->frame_bytes += 2;

    return enc;
}

int
ac3enc_encode(Ac3Encoder *enc, const int16_t *pcm_interleaved, uint8_t *out, int out_cap)
{
    int n;

    if (enc == NULL || pcm_interleaved == NULL || out == NULL) return -1;
    if (out_cap < enc->frame_bytes) return -2;

    /* Copy out of the caller's buffer before remapping: the caller keeps ownership of its PCM. */
    memcpy(enc->pcm, pcm_interleaved,
           sizeof(enc->pcm[0]) * AC3ENC_SAMPLES_PER_FRAME * AC3ENC_CHANNELS);

    /* Android/WAV order -> A/52 order, exactly once. */
    aften_remap_wav_to_a52(enc->pcm, AC3ENC_SAMPLES_PER_FRAME, AC3ENC_CHANNELS,
                           A52_SAMPLE_FMT_S16, enc->ctx.acmod);

    n = aften_encode_frame(&enc->ctx, out, enc->pcm);
    return n;
}

int
ac3enc_frame_bytes(const Ac3Encoder *enc)
{
    return enc == NULL ? 0 : enc->frame_bytes;
}

int
ac3enc_delay_frames(const Ac3Encoder *enc)
{
    return enc == NULL ? 0 : AC3ENC_DELAY_FRAMES;
}

void
ac3enc_close(Ac3Encoder *enc)
{
    if (enc == NULL) return;
    aften_encode_close(&enc->ctx);
    free(enc);
}
