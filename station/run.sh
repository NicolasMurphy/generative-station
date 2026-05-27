#!/bin/bash
set -e

: "${ICECAST_HOST:=icecast}"
: "${ICECAST_PORT:=8000}"
: "${ICECAST_MOUNT:=/stream}"
: "${ICECAST_SOURCE_USER:=source}"
: "${ICECAST_SOURCE_PASSWORD:?ICECAST_SOURCE_PASSWORD is required}"
: "${JACK_SAMPLE_RATE:=48000}"
: "${JACK_PERIOD:=1024}"

cleanup() {
    echo "[station] shutting down..."
    [ -n "${FFMPEG_PID:-}" ] && kill "$FFMPEG_PID" 2>/dev/null || true
    [ -n "${SCLANG_PID:-}" ] && kill "$SCLANG_PID" 2>/dev/null || true
    [ -n "${JACK_PID:-}" ] && kill "$JACK_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "[station] starting jackd (dummy backend, no realtime, no mlock, ${JACK_SAMPLE_RATE} Hz)..."
jackd --no-realtime -m -d dummy -r "$JACK_SAMPLE_RATE" -p "$JACK_PERIOD" &
JACK_PID=$!
sleep 3

if ! kill -0 "$JACK_PID" 2>/dev/null; then
    echo "[station] ERROR: jackd died during startup, aborting"
    exit 1
fi

echo "[station] starting sclang piece.scd..."
yes "" | sclang -i headless /app/piece.scd &
SCLANG_PID=$!

echo "[station] waiting for SuperCollider JACK ports..."
for _ in $(seq 1 30); do
    if jack_lsp 2>/dev/null | grep -q "^SuperCollider:out_1$"; then
        echo "[station] SuperCollider JACK ports ready"
        break
    fi
    sleep 1
done

echo "[station] waiting for icecast at ${ICECAST_HOST}:${ICECAST_PORT}..."
until nc -z "$ICECAST_HOST" "$ICECAST_PORT"; do
    sleep 1
done

echo "[station] starting ffmpeg encoder..."
ffmpeg -hide_banner -loglevel info \
    -f jack -i SC-Encoder -channels 2 \
    -c:a aac -b:a 128k -ar 48000 \
    -content_type audio/aac \
    -f adts "icecast://${ICECAST_SOURCE_USER}:${ICECAST_SOURCE_PASSWORD}@${ICECAST_HOST}:${ICECAST_PORT}${ICECAST_MOUNT}" &
FFMPEG_PID=$!

echo "[station] waiting for SC-Encoder JACK ports..."
for _ in $(seq 1 20); do
    if jack_lsp 2>/dev/null | grep -q "^SC-Encoder:input_1$"; then
        break
    fi
    sleep 1
done

echo "[station] wiring SuperCollider -> SC-Encoder..."
jack_connect SuperCollider:out_1 SC-Encoder:input_1 || true
jack_connect SuperCollider:out_2 SC-Encoder:input_2 || true

echo "[station] streaming. listen at http://localhost:8000/stream"

wait -n
