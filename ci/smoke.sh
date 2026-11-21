#!/bin/sh
# End-to-end check that CI runs before every deploy, on a throwaway Docker
# host. It builds the images, starts Icecast, the station and the picker,
# and fails unless:
#   - the picker's unit tests pass,
#   - the piece loads and the encoder connects to Icecast,
#   - the stream carries sound (a piece that failed to load streams silence),
#   - a compound posted to the webhook reaches SuperCollider,
#   - SuperCollider reported no errors along the way.
set -eu
cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
    cat > .env <<ENV
ICECAST_SOURCE_PASSWORD=ci-source
ICECAST_RELAY_PASSWORD=ci-relay
ICECAST_ADMIN_PASSWORD=ci-admin
STATION_WEBHOOK_SECRET=ci-secret
ENV
fi
secret=$(sed -n 's/^STATION_WEBHOOK_SECRET=//p' .env)

station_logs() {
    docker compose logs --no-color station 2>&1
}

fail() {
    echo
    echo "SMOKE TEST FAILED: $1"
    echo "--- last lines of the station log ---"
    docker compose logs --no-color --tail 80 station 2>&1 || true
    exit 1
}

echo "== building images"
docker compose build icecast station picker

echo "== picker unit tests"
docker compose run --rm --no-deps -T \
    -e PYTHONDONTWRITEBYTECODE=1 -v "$PWD/picker:/src:ro" --entrypoint sh picker \
    -c "pip install -q --root-user-action=ignore pytest && cd /src && python -m pytest -q -p no:cacheprovider"

echo "== starting icecast, station and picker"
docker compose up -d icecast station picker

echo "== waiting for the piece to load and the encoder to connect"
ready=""
i=0
while [ "$i" -lt 60 ]; do
    logs=$(station_logs)
    case "$logs" in
        *"[piece] all elements running"*)
            case "$logs" in
                *"[station] streaming"*) ready=1 ;;
            esac
            ;;
    esac
    if [ -n "$ready" ]; then
        break
    fi
    i=$((i + 1))
    sleep 3
done
[ -n "$ready" ] || fail "the station did not start streaming within 3 minutes"
echo "   station is streaming"

echo "== listening to the stream"
sleep 10 # let the first swells rise
volume=$(docker compose exec -T station ffmpeg -hide_banner -nostdin -nostats \
    -t 8 -i http://icecast:8000/stream -af volumedetect -f null - 2>&1 \
    | sed -n 's/.*mean_volume: \(-\{0,1\}[0-9.]*\) dB.*/\1/p' | tail -1)
[ -n "$volume" ] || fail "could not read the stream from Icecast"
echo "   mean volume over 8 s: $volume dB"
# Digital silence reads -91 dB; the piece at its quietest is far above -70.
awk "BEGIN { exit !($volume > -70) }" || fail "the stream is silent ($volume dB)"

echo "== posting a compound to the webhook"
answer=$(docker compose exec -T -e SECRET="$secret" picker python -c '
import json, os, urllib.request
body = json.dumps({
    "compound": "CI smoke test", "accession": "CI-1", "algorithm": "linear",
    "frequencies": [330.0, 440.0, 550.0], "amplitudes": [0.5, 1, 0.25],
}).encode()
request = urllib.request.Request(
    "http://127.0.0.1:9000/webhook", data=body,
    headers={"Authorization": "Bearer " + os.environ["SECRET"],
             "Content-Type": "application/json"})
print(json.load(urllib.request.urlopen(request, timeout=5))["status"])
') || fail "the webhook request failed"
[ "$answer" = "ok" ] || fail "the webhook answered '$answer', expected 'ok'"

arrived=""
i=0
while [ "$i" -lt 10 ]; do
    case "$(station_logs)" in
        *"[piece] compound: CI smoke test (3 peaks, 3 voiced)"*) arrived=1 ;;
    esac
    if [ -n "$arrived" ]; then
        break
    fi
    i=$((i + 1))
    sleep 2
done
[ -n "$arrived" ] || fail "the compound did not reach SuperCollider"
echo "   compound reached SuperCollider"

echo "== checking for errors after 15 s of the compound playing"
sleep 15
logs=$(station_logs)
case "$logs" in
    *"ERROR"* | *"FAILURE IN SERVER"*) fail "SuperCollider reported an error" ;;
esac
for c in gs-icecast gs-station gs-picker; do
    running=$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null || echo false)
    [ "$running" = "true" ] || fail "$c is not running"
done

echo
echo "smoke test passed"
