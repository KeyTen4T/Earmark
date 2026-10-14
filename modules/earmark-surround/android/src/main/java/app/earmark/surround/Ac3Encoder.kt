package app.earmark.surround

import java.nio.ByteBuffer

/**
 * AC-3 (Dolby Digital) encoder for 5.1 PCM, backed by the local `libearmarksurround.so`.
 *
 * Input is interleaved signed 16-bit little-endian PCM in Android/WAV channel order
 * (FL, FR, FC, LFE, BL, BR); output is one complete AC-3 sync frame per [encode] call.
 *
 * Both buffers must be *direct* [ByteBuffer]s, so the JNI layer can hand their addresses to C
 * without copying. Position the buffers at 0: the native side writes from the buffer base.
 *
 * Not thread-safe; one encoder per stream.
 */
class Ac3Encoder private constructor(private var handle: Long) {

    /** Size in bytes of one output AC-3 frame (constant for 48 kHz). */
    val frameBytes: Int
        get() = nativeFrameBytes(handle)

    /** Encoder start-up delay in samples (frames): 256. Not compensated here. */
    val delayFrames: Int
        get() = nativeDelayFrames(handle)

    /**
     * Encodes exactly 1536 frames of PCM from [pcm] into [out].
     * Returns the number of bytes of one complete AC-3 sync frame written.
     * Must not be called concurrently and must not be called after [close].
     */
    fun encode(pcm: ByteBuffer, out: ByteBuffer): Int {
        check(handle != 0L) { "Ac3Encoder is closed" }
        require(pcm.isDirect) { "pcm must be a direct ByteBuffer" }
        require(out.isDirect) { "out must be a direct ByteBuffer" }
        val written = nativeEncode(handle, pcm, out, out.remaining())
        check(written >= 0) { "ac3enc_encode failed: $written" }
        return written
    }

    /** Frees the native encoder. Safe to call more than once. */
    fun close() {
        val h = handle
        if (h != 0L) {
            handle = 0L
            nativeClose(h)
        }
    }

    companion object {
        init {
            System.loadLibrary("earmarksurround")
        }

        /**
         * Creates an encoder. [channels] must be 6; [sampleRate] must be 48000 or 44100;
         * [bitrateKbps] <= 0 selects the default of 640 kbps.
         */
        @JvmStatic
        fun open(sampleRate: Int, channels: Int = 6, bitrateKbps: Int = 640): Ac3Encoder {
            val handle = nativeOpen(sampleRate, channels, bitrateKbps)
            check(handle != 0L) {
                "ac3enc_open failed (sampleRate=$sampleRate channels=$channels bitrateKbps=$bitrateKbps)"
            }
            return Ac3Encoder(handle)
        }

        @JvmStatic
        private external fun nativeOpen(sampleRate: Int, channels: Int, bitrateKbps: Int): Long

        @JvmStatic
        private external fun nativeEncode(
            handle: Long,
            pcm: ByteBuffer,
            out: ByteBuffer,
            outCap: Int,
        ): Int

        @JvmStatic
        private external fun nativeFrameBytes(handle: Long): Int

        @JvmStatic
        private external fun nativeDelayFrames(handle: Long): Int

        @JvmStatic
        private external fun nativeClose(handle: Long)
    }
}
