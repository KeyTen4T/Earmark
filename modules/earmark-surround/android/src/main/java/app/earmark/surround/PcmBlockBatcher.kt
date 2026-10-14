package app.earmark.surround

import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Splits an interleaved PCM16 stream into fixed-size blocks and encodes each to one AC-3 frame.
 *
 * Deliberately free of Android and media3 types, so the block/timestamp/retry logic can be unit
 * tested with plain JUnit and fakes ([Ac3PassthroughAudioSink] supplies the real encoder and a
 * writer that forwards to the wrapped sink).
 *
 * The sink calls [process] with one input buffer at a time. Whole blocks are encoded and offered
 * to [writer] in order. If [writer] refuses a frame (returns false), that frame is retained and
 * [process] returns false immediately; the caller must not re-read the input from the start and
 * must call [process] again (which offers the pending frame first). At most one encoded frame is
 * ever pending, so the two direct buffers here are reused and no allocation happens per buffer.
 */
class PcmBlockBatcher(
    private val encoder: FrameEncoder,
    private val writer: FrameWriter,
    val channels: Int = 6,
    val bytesPerSample: Int = 2,
    val framesPerBlock: Int = FRAMES_PER_AC3_FRAME,
    private val sampleRate: Int,
) {
    /** One whole AC-3 encoder call. Faked in unit tests. */
    interface FrameEncoder {
        /** Size in bytes of one encoded frame. */
        val frameBytes: Int

        /** Encodes [framesPerBlock] PCM frames from [pcm] into [out]; returns bytes written. */
        fun encode(pcm: ByteBuffer, out: ByteBuffer): Int
    }

    /** Consumes one encoded frame. Returns false when the frame could not be taken in full. */
    fun interface FrameWriter {
        fun write(frame: ByteBuffer, presentationTimeUs: Long): Boolean
    }

    private val audioFrameBytes: Int = channels * bytesPerSample

    /** Bytes of PCM in one block, i.e. one AC-3 frame's worth. */
    val blockBytes: Int = framesPerBlock * audioFrameBytes

    private val partial: ByteBuffer = ByteBuffer.allocateDirect(blockBytes).order(ByteOrder.LITTLE_ENDIAN)
    // media3's DefaultAudioSink requires every buffer it is handed to be little-endian, encoded
    // buffers included; a direct buffer defaults to big-endian.
    private val encoded: ByteBuffer = ByteBuffer.allocateDirect(encoder.frameBytes).order(ByteOrder.LITTLE_ENDIAN)

    private var partialFrames: Int = 0
    private var blockStartUs: Long = TIME_UNSET
    private var pending: Boolean = false
    private var pendingTimeUs: Long = TIME_UNSET

    // Tracks the input buffer currently being consumed. media3 may hand the same buffer back
    // after a false return; [presentationTimeUs] is the time of the buffer's start, so the time
    // of the bytes it still holds must be offset by what was already consumed from it.
    private var activeInput: ByteBuffer? = null
    private var activeInputStartUs: Long = TIME_UNSET
    private var activeInputFrames: Long = 0

    /** PCM frames held in the partial block, not yet encoded. */
    val bufferedFrames: Int get() = partialFrames

    /** True when an encoded frame has not been accepted by the writer yet. */
    val hasPendingFrame: Boolean get() = pending

    /** True when there is either partial PCM or an unaccepted frame. */
    val hasBufferedData: Boolean get() = pending || partialFrames > 0

    /** Offers the pending frame, if any, to the writer. True when nothing is left pending. */
    fun drain(): Boolean {
        if (!pending) return true
        if (!writer.write(encoded, pendingTimeUs)) return false
        pending = false
        encoded.clear()
        return true
    }

    /**
     * Consumes whole blocks from [input]; [presentationTimeUs] is the time of the first sample the
     * buffer held when it was first handed over (the same value media3 passes again on a retry).
     * Returns true when [input] was consumed in full and no frame is left pending.
     */
    fun process(input: ByteBuffer, presentationTimeUs: Long): Boolean {
        if (input !== activeInput) {
            activeInput = input
            activeInputStartUs = presentationTimeUs
            activeInputFrames = 0
        }
        if (!drain()) return false
        var framesThisCall: Long = 0
        while (input.hasRemaining()) {
            if (partialFrames == 0) {
                blockStartUs = activeInputStartUs + framesToUs(activeInputFrames + framesThisCall)
            }
            val bytesFree = (framesPerBlock - partialFrames) * audioFrameBytes
            val toCopy = minOf(input.remaining(), bytesFree)
            copy(input, partial, toCopy)
            val copiedFrames = toCopy / audioFrameBytes
            partialFrames += copiedFrames
            framesThisCall += copiedFrames
            if (partialFrames == framesPerBlock) {
                encodePartial()
                if (!drain()) {
                    activeInputFrames += framesThisCall
                    return false
                }
            }
        }
        activeInputFrames += framesThisCall
        if (!input.hasRemaining()) {
            activeInput = null
            activeInputFrames = 0
        }
        return !pending
    }

    /**
     * Pads a partial final block with silence, encodes it and offers it. Safe to call again: it
     * only pads once. Returns true when everything has been handed to the writer.
     */
    fun finish(): Boolean {
        if (!drain()) return false
        if (partialFrames > 0) {
            while (partial.hasRemaining()) partial.put(0)
            encodePartial()
            if (!drain()) return false
        }
        return true
    }

    /** Drops both the partial PCM and a pending frame (a flush). */
    fun discard() {
        partial.clear()
        partialFrames = 0
        blockStartUs = TIME_UNSET
        pending = false
        pendingTimeUs = TIME_UNSET
        encoded.clear()
        activeInput = null
        activeInputFrames = 0
        activeInputStartUs = TIME_UNSET
    }

    /**
     * Pads the partial block with silence and encodes it as the pending frame (a discontinuity).
     * No PCM is dropped; the caller drains before consuming the discontinuous buffer.
     */
    fun padPartial() {
        if (partialFrames > 0 && !pending) {
            while (partial.hasRemaining()) partial.put(0)
            encodePartial()
        }
        activeInput = null
        activeInputFrames = 0
        activeInputStartUs = TIME_UNSET
    }

    private fun encodePartial() {
        partial.flip()
        encoded.clear()
        val written = encoder.encode(partial, encoded)
        encoded.position(0)
        encoded.limit(written)
        partial.clear()
        partialFrames = 0
        pending = true
        pendingTimeUs = blockStartUs
        blockStartUs = TIME_UNSET
    }

    private fun framesToUs(frames: Long): Long = frames * 1_000_000L / sampleRate

    private fun copy(from: ByteBuffer, to: ByteBuffer, count: Int) {
        if (from.remaining() > count) {
            val savedLimit = from.limit()
            from.limit(from.position() + count)
            to.put(from)
            from.limit(savedLimit)
        } else {
            to.put(from)
        }
    }

    companion object {
        /** Samples per AC-3 sync frame; also the encoder's fixed input block size. */
        const val FRAMES_PER_AC3_FRAME = 1536

        /** Sentinel for "no block started yet". */
        const val TIME_UNSET = Long.MIN_VALUE
    }
}
