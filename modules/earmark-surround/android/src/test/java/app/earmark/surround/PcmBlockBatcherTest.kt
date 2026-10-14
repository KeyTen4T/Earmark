package app.earmark.surround

import java.nio.ByteBuffer
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * JVM tests for the pure block/timestamp/retry logic. The encoder and the writer are fakes, so
 * this needs neither Android nor the native library.
 */
class PcmBlockBatcherTest {

    private val sampleRate = 48000
    private val channels = 6
    private val bytesPerSample = 2
    private val frameBytes = 2560 // one AC-3 frame at 640 kbps / 48 kHz
    private val audioFrameBytes = channels * bytesPerSample

    private fun batcher(encoder: FakeEncoder, writer: FakeWriter) =
        PcmBlockBatcher(
            encoder = encoder,
            writer = writer,
            channels = channels,
            bytesPerSample = bytesPerSample,
            framesPerBlock = PcmBlockBatcher.FRAMES_PER_AC3_FRAME,
            sampleRate = sampleRate,
        )

    private val blockFrames = PcmBlockBatcher.FRAMES_PER_AC3_FRAME
    private val blockBytes = blockFrames * audioFrameBytes

    @Test
    fun oneBlockInOneBuffer() {
        val encoder = FakeEncoder(frameBytes)
        val writer = FakeWriter()
        val sut = batcher(encoder, writer)
        val input = ByteBuffer.wrap(pcm(blockFrames))

        assertTrue(sut.process(input, 0L))

        assertEquals(1, encoder.blocks.size)
        assertEquals(1, writer.accepted.size)
        assertEquals(0L, writer.accepted[0].second)
        assertEquals(0, input.remaining())
        assertFalse(sut.hasPendingFrame)
    }

    @Test
    fun severalBlocksInOneBufferGetTheirOwnTimestamps() {
        val encoder = FakeEncoder(frameBytes)
        val writer = FakeWriter()
        val sut = batcher(encoder, writer)
        val input = ByteBuffer.wrap(pcm(blockFrames * 3))

        assertTrue(sut.process(input, 1_000_000L))

        assertEquals(3, writer.accepted.size)
        assertEquals(1_000_000L, writer.accepted[0].second)
        assertEquals(1_000_000L + 32_000L, writer.accepted[1].second)
        assertEquals(1_000_000L + 64_000L, writer.accepted[2].second)
    }

    @Test
    fun oddChunkSizesProduceWholeBlocksAndPadTheLastOne() {
        val encoder = FakeEncoder(frameBytes)
        val writer = FakeWriter()
        val sut = batcher(encoder, writer)
        val totalFrames = blockFrames * 2 + 100
        val all = pcm(totalFrames)

        var fed = 0
        val chunk = 7
        while (fed < totalFrames) {
            val n = minOf(chunk, totalFrames - fed)
            val input = ByteBuffer.wrap(all, fed * audioFrameBytes, n * audioFrameBytes)
            val pts = fed * 1_000_000L / sampleRate
            assertTrue(sut.process(input, pts))
            fed += n
        }

        assertEquals(2, encoder.blocks.size)
        assertEquals(2, writer.accepted.size)
        assertEquals(0L, writer.accepted[0].second)
        // Sample times are integers; splitting a block across chunk buffers can round by <1 us.
        assertEquals(32_000.0, writer.accepted[1].second.toDouble(), 1.0)
        assertEquals(100, sut.bufferedFrames)
        assertArrayEquals(
            all.copyOfRange(0, 2 * blockBytes),
            encoder.blocks[0] + encoder.blocks[1],
        )

        assertTrue(sut.finish())

        assertEquals(3, encoder.blocks.size)
        assertEquals(3, writer.accepted.size)
        assertEquals(64_000.0, writer.accepted[2].second.toDouble(), 1.0)
        val padded = encoder.blocks[2]
        assertEquals(blockBytes, padded.size)
        assertArrayEquals(
            all.copyOfRange(2 * blockBytes, all.size),
            padded.copyOfRange(0, 100 * audioFrameBytes),
        )
        assertArrayEquals(
            ByteArray((blockFrames - 100) * audioFrameBytes),
            padded.copyOfRange(100 * audioFrameBytes, blockBytes),
        )
    }

    @Test
    fun refusedFrameAfterFullInputIsRetriedWithoutReEncoding() {
        val encoder = FakeEncoder(frameBytes)
        val writer = FakeWriter(refuseCall = 1)
        val sut = batcher(encoder, writer)
        val input = ByteBuffer.wrap(pcm(blockFrames))

        assertFalse(sut.process(input, 0L))
        assertEquals(0, input.remaining())
        assertEquals(1, encoder.blocks.size)
        assertTrue(sut.hasPendingFrame)

        assertTrue(sut.process(input, 0L))

        assertEquals(1, encoder.blocks.size)
        assertEquals(1, writer.accepted.size)
        assertArrayEquals(
            encoder.blocks[0].copyOf(frameBytes),
            writer.accepted[0].first,
        )
        assertFalse(sut.hasPendingFrame)
    }

    @Test
    fun refusedFrameMidBufferKeepsRemainingInputAndTimestamps() {
        val encoder = FakeEncoder(frameBytes)
        val writer = FakeWriter(refuseCall = 2)
        val sut = batcher(encoder, writer)
        val all = pcm(blockFrames * 3)
        val input = ByteBuffer.wrap(all)

        assertFalse(sut.process(input, 100L))
        // Exactly two blocks were taken from the buffer; the third is still there.
        assertEquals(2 * blockBytes, input.position())
        assertEquals(1, writer.accepted.size)
        assertTrue(sut.hasPendingFrame)

        // The same buffer is offered again; it must not be re-read from the start.
        assertTrue(sut.process(input, 100L))

        assertEquals(0, input.remaining())
        assertEquals(3, encoder.blocks.size)
        assertEquals(3, writer.accepted.size)
        assertEquals(100L, writer.accepted[0].second)
        assertEquals(100L + 32_000L, writer.accepted[1].second)
        assertEquals(100L + 64_000L, writer.accepted[2].second)
        assertArrayEquals(
            all,
            encoder.blocks[0] + encoder.blocks[1] + encoder.blocks[2],
        )
    }

    @Test
    fun finalPaddingIsRetriedWithoutRePadding() {
        val encoder = FakeEncoder(frameBytes)
        val writer = FakeWriter(refuseCall = 1)
        val sut = batcher(encoder, writer)

        assertTrue(sut.process(ByteBuffer.wrap(pcm(100)), 0L))
        assertFalse(sut.finish())
        assertTrue(sut.hasPendingFrame)
        assertEquals(1, encoder.blocks.size)

        assertTrue(sut.finish())
        assertEquals(1, encoder.blocks.size)
        assertEquals(1, writer.accepted.size)
        assertEquals(blockBytes, encoder.blocks[0].size)
    }

    @Test
    fun discardDropsPartialPcmAndPendingFrame() {
        val encoder = FakeEncoder(frameBytes)
        val writer = FakeWriter(refuseCall = 1)
        val sut = batcher(encoder, writer)

        assertFalse(sut.process(ByteBuffer.wrap(pcm(blockFrames + 10)), 0L))
        assertTrue(sut.hasPendingFrame)

        sut.discard()

        assertFalse(sut.hasPendingFrame)
        assertEquals(0, sut.bufferedFrames)
        assertTrue(sut.drain())
    }

    @Test
    fun discontinuityPadsPartialWithoutDroppingPcm() {
        val encoder = FakeEncoder(frameBytes)
        val writer = FakeWriter()
        val sut = batcher(encoder, writer)
        val real = pcm(100)

        assertTrue(sut.process(ByteBuffer.wrap(real), 100L))
        assertEquals(100, sut.bufferedFrames)

        sut.padPartial()

        assertEquals(0, sut.bufferedFrames)
        assertTrue(sut.hasPendingFrame)
        assertEquals(1, encoder.blocks.size)
        assertEquals(blockBytes, encoder.blocks[0].size)
        assertArrayEquals(real, encoder.blocks[0].copyOf(100 * audioFrameBytes))
        assertArrayEquals(
            ByteArray((blockFrames - 100) * audioFrameBytes),
            encoder.blocks[0].copyOfRange(100 * audioFrameBytes, blockBytes),
        )

        assertTrue(sut.drain())
        assertEquals(1, writer.accepted.size)
        assertEquals(100L, writer.accepted[0].second)
    }

    @Test
    fun emptyBufferWithNothingPendingIsHandled() {
        val sut = batcher(FakeEncoder(frameBytes), FakeWriter())
        assertTrue(sut.process(ByteBuffer.allocate(0), 0L))
    }

    /** Interleaved PCM with a non-constant pattern so padding (zeros) is distinguishable. */
    private fun pcm(frames: Int): ByteArray =
        ByteArray(frames * audioFrameBytes) { (it and 0xFF).toByte() }

    private class FakeEncoder(override val frameBytes: Int) : PcmBlockBatcher.FrameEncoder {
        val blocks = ArrayList<ByteArray>()

        override fun encode(pcm: ByteBuffer, out: ByteBuffer): Int {
            val block = ByteArray(pcm.remaining())
            pcm.get(block)
            blocks.add(block)
            val n = minOf(frameBytes, block.size)
            out.put(block, 0, n)
            repeat(frameBytes - n) { out.put(0) }
            return frameBytes
        }
    }

    private class FakeWriter(private val refuseCall: Int = Int.MAX_VALUE) :
        PcmBlockBatcher.FrameWriter {
        var calls = 0
        val accepted = ArrayList<Pair<ByteArray, Long>>()

        override fun write(frame: ByteBuffer, presentationTimeUs: Long): Boolean {
            calls++
            // media3 rejects any buffer that is not little-endian, encoded frames included.
            assertEquals(java.nio.ByteOrder.LITTLE_ENDIAN, frame.order())
            if (calls == refuseCall) return false
            val bytes = ByteArray(frame.remaining())
            frame.get(bytes)
            accepted.add(bytes to presentationTimeUs)
            return true
        }
    }
}
