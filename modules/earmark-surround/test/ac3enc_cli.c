/*
 * ac3enc_cli.c - host CLI used by test/roundtrip.sh.
 *
 * Reads raw interleaved signed 16-bit little-endian 6-channel 48 kHz PCM (no header) from argv[1]
 * and writes an AC-3 elementary stream to argv[2]. Optional argv[3] overrides the bitrate in kbps.
 *
 * Prints the encoder facts the round-trip test asserts on (frame size, delay, frame counts) to
 * stderr as key=value lines.
 */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "ac3enc.h"

#define SAMPLE_RATE 48000

int
main(int argc, char **argv)
{
    FILE *in, *out;
    Ac3Encoder *enc = NULL;
    int bitrate = (argc > 3) ? atoi(argv[3]) : 640;
    int frame_bytes, delay;
    int16_t *pcm;
    uint8_t *frame;
    long long in_frames = 0, out_frames = 0, out_bytes = 0;
    size_t got;
    int rc = 0;

    if (argc < 3) {
        fprintf(stderr, "usage: %s <in.s16le> <out.ac3> [bitrate_kbps]\n", argv[0]);
        return 2;
    }

    enc = ac3enc_open(SAMPLE_RATE, AC3ENC_CHANNELS, bitrate);
    if (enc == NULL) {
        fprintf(stderr, "ac3enc_open failed\n");
        return 1;
    }
    frame_bytes = ac3enc_frame_bytes(enc);
    delay = ac3enc_delay_frames(enc);
    fprintf(stderr, "sample_rate=%d\n", SAMPLE_RATE);
    fprintf(stderr, "channels=%d\n", AC3ENC_CHANNELS);
    fprintf(stderr, "bitrate_kbps=%d\n", bitrate);
    fprintf(stderr, "frame_bytes=%d\n", frame_bytes);
    fprintf(stderr, "delay_frames=%d\n", delay);

    in = fopen(argv[1], "rb");
    if (in == NULL) {
        perror("open input");
        ac3enc_close(enc);
        return 1;
    }
    out = fopen(argv[2], "wb");
    if (out == NULL) {
        perror("open output");
        fclose(in);
        ac3enc_close(enc);
        return 1;
    }

    pcm = (int16_t *)calloc((size_t)AC3ENC_SAMPLES_PER_FRAME * AC3ENC_CHANNELS, sizeof(int16_t));
    frame = (uint8_t *)malloc((size_t)frame_bytes);
    if (pcm == NULL || frame == NULL) {
        fprintf(stderr, "out of memory\n");
        rc = 1;
        goto cleanup;
    }

    for (;;) {
        got = fread(pcm, sizeof(int16_t), (size_t)AC3ENC_SAMPLES_PER_FRAME * AC3ENC_CHANNELS, in);
        if (got == 0) break;
        if (got < (size_t)AC3ENC_SAMPLES_PER_FRAME * AC3ENC_CHANNELS) {
            /* Zero-pad the final partial frame, like the aften CLI. */
            memset(pcm + got, 0,
                   ((size_t)AC3ENC_SAMPLES_PER_FRAME * AC3ENC_CHANNELS - got) * sizeof(int16_t));
        }
        {
            int written = ac3enc_encode(enc, pcm, frame, frame_bytes);
            if (written < 0) {
                fprintf(stderr, "ac3enc_encode failed: %d\n", written);
                rc = 1;
                goto cleanup;
            }
            if (fwrite(frame, 1, (size_t)written, out) != (size_t)written) {
                perror("write output");
                rc = 1;
                goto cleanup;
            }
            out_frames++;
            out_bytes += written;
        }
        in_frames++;
    }

    fprintf(stderr, "input_frames=%lld\n", in_frames);
    fprintf(stderr, "output_frames=%lld\n", out_frames);
    fprintf(stderr, "output_bytes=%lld\n", out_bytes);

cleanup:
    free(pcm);
    free(frame);
    fclose(in);
    fclose(out);
    ac3enc_close(enc);
    return rc;
}
