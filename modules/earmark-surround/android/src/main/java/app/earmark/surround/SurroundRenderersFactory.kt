package app.earmark.surround

import android.content.Context
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.audio.AudioSink

/**
 * The stock [DefaultRenderersFactory] with one change: the audio sink it builds is wrapped in an
 * [Ac3PassthroughAudioSink], so 5.1 PCM can be encoded to AC-3 when the device needs it.
 *
 * expo-audio instantiates this class by name through reflection (see the expo-audio patch), so it
 * keeps a plain public `(Context)` constructor and is kept by ProGuard.
 */
@UnstableApi
class SurroundRenderersFactory(context: Context) : DefaultRenderersFactory(context) {

    override fun buildAudioSink(
        context: Context,
        enableFloatOutput: Boolean,
        enableAudioOutputPlaybackParameters: Boolean,
    ): AudioSink? {
        val inner =
            super.buildAudioSink(context, enableFloatOutput, enableAudioOutputPlaybackParameters)
                ?: return null
        return Ac3PassthroughAudioSink(context, inner)
    }
}
