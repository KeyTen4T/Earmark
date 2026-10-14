package app.earmark.surround

import android.content.Context
import android.content.IntentFilter
import android.media.AudioManager
import android.util.Log
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackParameters
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.audio.AudioCapabilities
import androidx.media3.exoplayer.audio.AudioSink
import androidx.media3.exoplayer.audio.ForwardingAudioSink
import java.nio.ByteBuffer

/**
 * The path chosen by the most recently configured sink, without any media3 annotation, so the
 * EarmarkSurround Expo module can read it without opting in to an unstable API. One of "ac3",
 * "pcm" or "idle". A later task shows it in the UI; the app's JavaScript does not use it yet.
 */
object SurroundOutputMode {
    const val IDLE = "idle"
    const val PCM = "pcm"
    const val AC3 = "ac3"

    @Volatile
    var current: String = IDLE
        internal set
}

/**
 * An [AudioSink] that forwards to a [androidx.media3.exoplayer.audio.DefaultAudioSink], except that
 * 6-channel PCM16 is encoded to AC-3 and fed to the inner sink as passthrough when the device
 * cannot play 6-channel PCM but can pass AC-3 through.
 *
 * The decision is made in [configure]. Everything else (phones, headphones, Bluetooth, stereo
 * books, TVs with real multichannel PCM, non-1x playback) is forwarded untouched, so playback is
 * never worse than before. If the encoder cannot be loaded or opened, the sink falls back to plain
 * forwarding.
 */
@UnstableApi
class Ac3PassthroughAudioSink(
    context: Context,
    private val inner: AudioSink,
) : ForwardingAudioSink(inner), PcmBlockBatcher.FrameWriter {

    private val appContext: Context = context.applicationContext

    private var inputFormat: Format? = null
    private var specifiedBufferSize: Int = 0
    private var outputChannels: IntArray? = null

    private var parameters: PlaybackParameters = PlaybackParameters.DEFAULT

    private var encoder: Ac3Encoder? = null
    private var delayFrames: Int = 0
    private var sampleRate: Int = 0
    private var batcher: PcmBlockBatcher? = null

    @Volatile
    private var mode: Mode = Mode.IDLE

    private val encoding: Boolean get() = mode == Mode.AC3 && batcher != null

    override fun configure(inputFormat: Format, specifiedBufferSize: Int, outputChannels: IntArray?) {
        this.inputFormat = inputFormat
        this.specifiedBufferSize = specifiedBufferSize
        this.outputChannels = outputChannels
        apply(decide(inputFormat))
    }

    /**
     * Speed or pitch changing away from 1.0 while AC-3 encoding is active switches to the plain
     * PCM path. The inner sink is reconfigured for the PCM format, so its position restarts from
     * the next buffer's presentation time and no media time is lost; a later change back to 1.0
     * switches to AC-3 again.
     */
    override fun setPlaybackParameters(playbackParameters: PlaybackParameters) {
        parameters = playbackParameters
        val format = inputFormat
        if (format != null) {
            val decision = decide(format)
            if (decision.mode != mode) {
                apply(decision)
            }
        }
        inner.setPlaybackParameters(playbackParameters)
    }

    /**
     * Media time of the PCM that is audibly playing. The inner sink reports it from the AC-3 frames
     * it has played; aften's 256-sample start-up delay shifts the audible content that far behind
     * the stream, so subtract it. PCM still held in the partial block is intentionally not added:
     * like the stock sink, this reports the played position, not the consumed position, and adding
     * it would overstate the position by up to one block (32 ms).
     */
    override fun getCurrentPositionUs(sourceEnded: Boolean): Long {
        val position = inner.getCurrentPositionUs(sourceEnded)
        if (!encoding || position == AudioSink.CURRENT_POSITION_NOT_SET) return position
        val delayUs = if (sampleRate > 0) delayFrames * 1_000_000L / sampleRate else 0
        return (position - delayUs).coerceAtLeast(0)
    }

    override fun handleBuffer(
        buffer: ByteBuffer,
        presentationTimeUs: Long,
        encodedAccessUnitCount: Int,
    ): Boolean {
        val batcher = this.batcher
        if (!encoding || batcher == null) {
            return inner.handleBuffer(buffer, presentationTimeUs, encodedAccessUnitCount)
        }
        return try {
            if (!batcher.drain()) return false
            batcher.process(buffer, presentationTimeUs)
        } catch (error: Throwable) {
            // Never crash playback on an encoder problem: drop the encoder and forward the rest.
            Log.w(TAG, "AC-3 encode failed, falling back to PCM", error)
            fallBackToPcm()
            inner.handleBuffer(buffer, presentationTimeUs, encodedAccessUnitCount)
        }
    }

    override fun playToEndOfStream() {
        if (encoding) {
            // Pads the final partial block with silence and offers it; a refused frame is retried
            // when the renderer calls this again.
            batcher?.finish()
        }
        inner.playToEndOfStream()
    }

    override fun isEnded(): Boolean {
        val batcher = this.batcher
        if (encoding && batcher != null && batcher.hasBufferedData) return false
        return inner.isEnded()
    }

    override fun hasPendingData(): Boolean {
        val batcher = this.batcher
        if (encoding && batcher != null && batcher.hasPendingFrame) return true
        return inner.hasPendingData()
    }

    override fun handleDiscontinuity() {
        // Pad the partial block with silence and keep it, so no PCM is dropped across the jump;
        // it is offered to the inner sink before the next (discontinuous) buffer.
        if (encoding) batcher?.padPartial()
        inner.handleDiscontinuity()
    }

    override fun flush() {
        if (encoding) {
            batcher?.discard()
            // aften keeps the last 256 samples as history; a fresh encoder clears them.
            encoder = openEncoder()
            if (encoder == null) {
                switchToPcm("encoder unavailable")
            }
        }
        inner.flush()
    }

    override fun reset() {
        closeEncoder()
        batcher = null
        mode = Mode.IDLE
        inputFormat = null
        SurroundOutputMode.current = SurroundOutputMode.IDLE
        inner.reset()
    }

    override fun release() {
        closeEncoder()
        batcher = null
        mode = Mode.IDLE
        SurroundOutputMode.current = SurroundOutputMode.IDLE
        inner.release()
    }

    /** [PcmBlockBatcher.FrameWriter] over the inner sink. */
    override fun write(frame: ByteBuffer, presentationTimeUs: Long): Boolean =
        inner.handleBuffer(frame, presentationTimeUs, 1)

    private fun decide(format: Format): Decision {
        if (!isSixChannelPcm16(format)) return Decision(Mode.PCM, "not 6-channel PCM16")
        val rate = format.sampleRate
        if (rate != 48000 && rate != 44100) return Decision(Mode.PCM, "rate $rate")
        if (parameters.speed != 1f) return Decision(Mode.PCM, "speed ${parameters.speed}")
        if (parameters.pitch != 1f) return Decision(Mode.PCM, "pitch ${parameters.pitch}")

        // The advertised PCM channel count is not used: on an Nvidia Shield the HDMI plug broadcast
        // reports 6+ while the HAL refuses 6-channel PCM (the TV's ELD allows 2), so Android
        // downmixes. AC-3 whenever the route takes it is lossy only on an already lossy source.
        val attributes = inner.audioAttributes ?: AudioAttributes.DEFAULT
        Log.d(TAG, "advertised pcm channels ${maxPcmChannelCount(attributes)}")

        val capabilities = AudioCapabilities.getCapabilities(appContext, attributes, null)
        if (!capabilities.isPassthroughPlaybackSupported(ac3Format(format), attributes)) {
            return Decision(Mode.PCM, "no ac3 passthrough")
        }
        return Decision(Mode.AC3, null)
    }

    /**
     * The number of PCM channels the current output can play.
     *
     * media3's `AudioCapabilities.getMaxChannelCount()` is not usable for this: before API 33 it
     * is 10 for every encoding, on TV and on most non-Bluetooth routes alike, and on API 33+ it
     * takes the maximum over PCM and surround profiles. The HDMI plug broadcast carries the
     * attached sink's PCM channel count, the same ELD data the audio HAL uses to refuse
     * multichannel PCM, so it is preferred whenever an HDMI sink is plugged in.
     */
    private fun maxPcmChannelCount(attributes: AudioAttributes): Int {
        @Suppress("DEPRECATION")
        val hdmi =
            appContext.registerReceiver(null, IntentFilter(AudioManager.ACTION_HDMI_AUDIO_PLUG))
        if (hdmi != null && hdmi.getIntExtra(AudioManager.EXTRA_AUDIO_PLUG_STATE, 0) == 1) {
            val hdmiMax = hdmi.getIntExtra(AudioManager.EXTRA_MAX_CHANNEL_COUNT, 0)
            if (hdmiMax > 0) return hdmiMax
        }
        return AudioCapabilities.getCapabilities(appContext, attributes, null).maxChannelCount
    }

    private fun apply(decision: Decision) {
        if (decision.mode != Mode.AC3) {
            switchToPcm(decision.reason ?: "pcm")
            return
        }
        val format = inputFormat
        if (format == null) {
            switchToPcm("no input format")
            return
        }
        val opened = openEncoder()
        if (opened == null) {
            switchToPcm("encoder unavailable")
            return
        }
        encoder = opened
        delayFrames = opened.delayFrames
        sampleRate = format.sampleRate
        batcher =
            PcmBlockBatcher(
                encoder = BatcherEncoder(),
                writer = this,
                channels = CHANNELS,
                bytesPerSample = BYTES_PER_SAMPLE,
                framesPerBlock = PcmBlockBatcher.FRAMES_PER_AC3_FRAME,
                sampleRate = sampleRate,
            )
        try {
            inner.configure(ac3Format(format), specifiedBufferSize, null)
        } catch (error: Throwable) {
            Log.w(TAG, "AC-3 passthrough configure failed, falling back to PCM", error)
            switchToPcm("ac3 configure failed")
            return
        }
        mode = Mode.AC3
        SurroundOutputMode.current = SurroundOutputMode.AC3
        Log.i(TAG, "passthrough ac3 5.1 $sampleRate")
    }

    private fun switchToPcm(reason: String) {
        closeEncoder()
        batcher = null
        mode = Mode.PCM
        SurroundOutputMode.current = SurroundOutputMode.PCM
        inputFormat?.let { inner.configure(it, specifiedBufferSize, outputChannels) }
        Log.i(TAG, "pcm: $reason")
    }

    /** Emergency PCM switch from [handleBuffer]; the next buffer is forwarded untouched. */
    private fun fallBackToPcm() {
        val format = inputFormat ?: return
        closeEncoder()
        batcher = null
        mode = Mode.PCM
        SurroundOutputMode.current = SurroundOutputMode.PCM
        try {
            inner.configure(format, specifiedBufferSize, outputChannels)
        } catch (error: Throwable) {
            Log.w(TAG, "PCM fallback configure failed", error)
        }
    }

    private fun openEncoder(): Ac3Encoder? {
        closeEncoder()
        val format = inputFormat ?: return null
        return try {
            Ac3Encoder.open(format.sampleRate, CHANNELS, BITRATE_KBPS).also { delayFrames = it.delayFrames }
        } catch (error: Throwable) {
            Log.w(TAG, "AC-3 encoder unavailable", error)
            null
        }
    }

    private fun closeEncoder() {
        encoder?.close()
        encoder = null
    }

    private fun isSixChannelPcm16(format: Format): Boolean =
        MimeTypes.AUDIO_RAW == format.sampleMimeType &&
            format.pcmEncoding == C.ENCODING_PCM_16BIT &&
            format.channelCount == CHANNELS

    private fun ac3Format(pcm: Format): Format =
        Format.Builder()
            .setSampleMimeType(MimeTypes.AUDIO_AC3)
            .setSampleRate(pcm.sampleRate)
            .setChannelCount(CHANNELS)
            .build()

    private inner class BatcherEncoder : PcmBlockBatcher.FrameEncoder {
        override val frameBytes: Int get() = encoder?.frameBytes ?: 0

        override fun encode(pcm: ByteBuffer, out: ByteBuffer): Int =
            checkNotNull(encoder) { "AC-3 encoder is closed" }.encode(pcm, out)
    }

    private enum class Mode { IDLE, AC3, PCM }

    private class Decision(val mode: Mode, val reason: String?)

    companion object {
        const val TAG = "EarmarkSurround"

        private const val CHANNELS = 6
        private const val BYTES_PER_SAMPLE = 2
        private const val BITRATE_KBPS = 640
    }
}
