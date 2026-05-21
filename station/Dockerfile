FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV QT_QPA_PLATFORM=offscreen
ENV QTWEBENGINE_DISABLE_SANDBOX=1
ENV QTWEBENGINE_CHROMIUM_FLAGS=--no-sandbox

RUN apt-get update && apt-get install -y --no-install-recommends \
        supercollider-server \
        supercollider-language \
        jackd2 \
        jack-tools \
        libjack-jackd2-0 \
        ffmpeg \
        netcat-openbsd \
        procps \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY piece.scd run.sh ./
RUN chmod +x run.sh

CMD ["/app/run.sh"]
