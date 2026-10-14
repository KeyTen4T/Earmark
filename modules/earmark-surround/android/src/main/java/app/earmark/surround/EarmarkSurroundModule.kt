package app.earmark.surround

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.nio.ByteBuffer

/**
 * Minimal Expo module whose only purpose is to make autolinking include this module's Android
 * library and to expose the surround status to JavaScript.
 *
 * `encoderSelfTest()` encodes one frame of silence and returns the frame's byte count.
 * `outputMode()` returns the path chosen by the most recently configured audio sink: "ac3",
 * "pcm" or "idle". The app's JavaScript does not call either yet.
 */
class EarmarkSurroundModule : Module() {
    override fun definition() = ModuleDefinition {
        Name("EarmarkSurround")

        Function("encoderSelfTest") {
            val encoder = Ac3Encoder.open(sampleRate = 48000, channels = 6, bitrateKbps = 640)
            try {
                val silence = ByteBuffer.allocateDirect(1536 * 6 * 2)
                val frame = ByteBuffer.allocateDirect(encoder.frameBytes)
                encoder.encode(silence, frame)
            } finally {
                encoder.close()
            }
        }

        Function("outputMode") {
            SurroundOutputMode.current
        }
    }
}
