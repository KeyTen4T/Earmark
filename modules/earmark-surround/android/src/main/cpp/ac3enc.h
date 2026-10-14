/*
 * ac3enc.h - thin, JNI-independent C API over the vendored aften 0.0.8 AC-3 encoder.
 *
 * One encoder instance accepts 5.1 (6-channel) interleaved signed 16-bit PCM in Android/WAV
 * channel order (FL, FR, FC, LFE, BL, BR) and produces one complete AC-3 sync frame per call.
 *
 * See ac3enc.c for the channel-order and delay notes.
 */
#ifndef EARMARK_AC3ENC_H
#define EARMARK_AC3ENC_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Fixed frame length: both the number of input frames ac3enc_encode() requires and the number of
 * audio frames carried by one AC-3 sync frame. */
#define AC3ENC_SAMPLES_PER_FRAME 1536

/* Only 6-channel (5.1 + LFE) input is supported. */
#define AC3ENC_CHANNELS 6

typedef struct Ac3Encoder Ac3Encoder;

/*
 * Creates an encoder. channels must be 6; sample_rate must be 48000 or 44100; bitrate_kbps <= 0
 * selects the default of 640 kbps. Returns NULL on any invalid argument or on encoder init
 * failure.
 */
Ac3Encoder *ac3enc_open(int sample_rate, int channels, int bitrate_kbps);

/*
 * Encodes exactly AC3ENC_SAMPLES_PER_FRAME frames of interleaved int16 PCM (Android/WAV channel
 * order) into out. Returns the number of bytes of one complete AC-3 sync frame written, or a
 * negative value on error (including out_cap too small).
 */
int ac3enc_encode(Ac3Encoder *enc, const int16_t *pcm_interleaved, uint8_t *out, int out_cap);

/* Size in bytes of one output frame. Constant for 48000; at 44100 the AC-3 frame-size table makes
 * CBR frames alternate by one word, and this reports the larger of the two. */
int ac3enc_frame_bytes(const Ac3Encoder *enc);

/* Encoder start-up delay in samples (frames): 256 for aften. Not compensated anywhere here. */
int ac3enc_delay_frames(const Ac3Encoder *enc);

/* Frees the encoder. Safe on NULL. */
void ac3enc_close(Ac3Encoder *enc);

#ifdef __cplusplus
}
#endif

#endif /* EARMARK_AC3ENC_H */
