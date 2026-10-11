# Read-along job service. Build context is the repo's tools/readalong/ directory:
#
#   docker build -f server/Dockerfile -t readalong-server:test .
#
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONDONTWRITEBYTECODE=1

# ffmpeg/ffprobe are used by readalong.py to cut and probe clips.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

# Whatever `anchors --paragraphs` needs: faster-whisper (ctranslate2 + tokenizers + huggingface_hub),
# numpy for the WAV decode, requests for the TorBox download, BeautifulSoup/lxml for the EPUB path.
RUN pip install faster-whisper numpy rapidfuzz beautifulsoup4 lxml requests

WORKDIR /app

# readalong.py sits beside server.py, which is what server.py's default READALONG_SCRIPT expects.
COPY readalong.py /app/readalong.py
COPY server/server.py /app/server.py
COPY server/gist.py /app/gist.py

# Run as a non-root user; /data is the state volume.
RUN useradd --create-home --uid 10001 readalong \
 && mkdir -p /data \
 && chown -R readalong:readalong /data /app

USER readalong

# Pre-download the base.en model at build time, as the runtime user, so the image is self-contained
# and starts without network access to Hugging Face. (MODEL can still override at runtime.)
RUN python -c "from faster_whisper import WhisperModel; WhisperModel('base.en', device='cpu', compute_type='int8')"

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD python -c "import sys, urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/readalong/v1/health', timeout=5).status == 200 else 1)"

CMD ["python", "server.py"]
