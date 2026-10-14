/*
 * jni.c - JNI bridge from app.earmark.surround.Ac3Encoder to the ac3enc C API.
 *
 * The Kotlin methods are `external`, so their JNI names are the mangled Java names below. All
 * work happens on direct ByteBuffers: GetDirectBufferAddress() gives the native pointer without
 * copying and without allocating, so encode() performs no per-call allocation.
 */
#include <jni.h>
#include <stddef.h>
#include <stdint.h>

#include "ac3enc.h"

/* One frame is fixed: 1536 samples * 6 channels * 2 bytes. */
#define PCM_FRAME_BYTES ((jlong)AC3ENC_SAMPLES_PER_FRAME * AC3ENC_CHANNELS * 2)

static Ac3Encoder *
encoder_from_handle(jlong handle)
{
    return (Ac3Encoder *)(intptr_t)handle;
}

JNIEXPORT jlong JNICALL
Java_app_earmark_surround_Ac3Encoder_nativeOpen(JNIEnv *env, jclass clazz,
                                                jint sample_rate, jint channels,
                                                jint bitrate_kbps)
{
    (void)env;
    (void)clazz;
    return (jlong)(intptr_t)ac3enc_open((int)sample_rate, (int)channels, (int)bitrate_kbps);
}

JNIEXPORT jint JNICALL
Java_app_earmark_surround_Ac3Encoder_nativeFrameBytes(JNIEnv *env, jclass clazz, jlong handle)
{
    (void)env;
    (void)clazz;
    return ac3enc_frame_bytes(encoder_from_handle(handle));
}

JNIEXPORT jint JNICALL
Java_app_earmark_surround_Ac3Encoder_nativeDelayFrames(JNIEnv *env, jclass clazz, jlong handle)
{
    (void)env;
    (void)clazz;
    return ac3enc_delay_frames(encoder_from_handle(handle));
}

JNIEXPORT jint JNICALL
Java_app_earmark_surround_Ac3Encoder_nativeEncode(JNIEnv *env, jclass clazz, jlong handle,
                                                  jobject pcm, jobject out, jint out_cap)
{
    Ac3Encoder *enc;
    void *pcm_ptr;
    void *out_ptr;

    (void)clazz;

    enc = encoder_from_handle(handle);
    if (enc == NULL) return -1;
    if (pcm == NULL || out == NULL) return -1;

    if ((*env)->GetDirectBufferCapacity(env, pcm) < PCM_FRAME_BYTES) return -2;
    if ((*env)->GetDirectBufferCapacity(env, out) < (jlong)out_cap) return -2;

    pcm_ptr = (*env)->GetDirectBufferAddress(env, pcm);
    out_ptr = (*env)->GetDirectBufferAddress(env, out);
    if (pcm_ptr == NULL || out_ptr == NULL) return -2; /* not a direct buffer */

    return ac3enc_encode(enc, (const int16_t *)pcm_ptr, (uint8_t *)out_ptr, (int)out_cap);
}

JNIEXPORT void JNICALL
Java_app_earmark_surround_Ac3Encoder_nativeClose(JNIEnv *env, jclass clazz, jlong handle)
{
    (void)env;
    (void)clazz;
    ac3enc_close(encoder_from_handle(handle));
}
