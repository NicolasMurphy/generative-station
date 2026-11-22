#!/bin/sh
# End-to-end check that CI runs before every deploy, on a throwaway Docker
# host. It builds the images, starts the whole stack with Caddy serving
# plain HTTP on localhost (ports 80 and 8000 must be free), and fails unless:
#   - the picker's unit tests pass,
#   - the piece loads and the encoder connects to Icecast,
#   - the stream carries sound (a piece that failed to load streams silence),
#   - Caddy serves the page, its script and the stream, and nothing of
#     Icecast's own pages,
#   - a compound posted to the public webhook reaches SuperCollider and
#     shows up on /current,
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
# Plain HTTP on localhost, so Caddy does not ask for a real certificate.
STATION_SITE="${STATION_SITE:-http://localhost}"
export STATION_SITE
site=http://localhost

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

echo "== starting the stack"
docker compose up -d

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

echo "== the public site, through Caddy"
sh ci/check-site.sh "$site" || fail "the site check failed"
script=$(sed -n 's/.*"three": "\([^"]*\)".*/\1/p' web/index.html)
[ "$(curl -s -o /dev/null -m 10 -w '%{http_code}' "$site/current")" = "204" ] \
    || fail "/current is not empty before any compound"

echo "== the visit counter"
first=$(curl -fsS -m 10 -X POST "$site/visit") || fail "/visit did not answer"
again=$(curl -fsS -m 10 -X POST "$site/visit") || fail "/visit did not answer twice"
[ "$first" = "$again" ] || fail "a second visit from the same address was counted ($first then $again)"
case "$(curl -fsS -m 10 "$site/stats")" in
    *'"visits":1'*) ;;
    *) fail "/stats does not show the visit" ;;
esac
docker compose restart picker >/dev/null 2>&1
i=0
kept=""
while [ "$i" -lt 15 ]; do
    case "$(curl -s -m 5 "$site/stats" || true)" in
        *'"visits":1'*) kept=1 ;;
    esac
    if [ -n "$kept" ]; then
        break
    fi
    i=$((i + 1))
    sleep 2
done
[ -n "$kept" ] || fail "the visit count did not survive a picker restart"
echo "   counted once per address, and kept across a picker restart"

echo "== the same page straight from Icecast (local runs use port 8000)"
curl -fsS -m 10 http://127.0.0.1:8000/ | grep -q '<title>' || fail "Icecast does not serve the page at /"
for path in "$script" /viz-bloom.js /viz-ripples.js /viz-rings.js; do
    direct=$(curl -s -o /dev/null -m 10 -w '%{content_type}' "http://127.0.0.1:8000$path" || true)
    case "$direct" in
        *javascript*) ;;
        *) fail "Icecast serves $path as '$direct', not JavaScript" ;;
    esac
done

echo "== posting a compound to the webhook"
answer=$(curl -s -m 10 "$site/webhook" \
    -H "Authorization: Bearer $secret" -H "Content-Type: application/json" \
    -d '{"compound":"CI smoke test","accession":"CI-1","algorithm":"linear","frequencies":[330.0,440.0,550.0],"amplitudes":[0.5,1,0.25]}') \
    || fail "the webhook request failed"
case "$answer" in
    *'"status":"ok"'*) ;;
    *) fail "the webhook answered '$answer', expected status ok" ;;
esac

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
case "$(curl -s -m 10 "$site/current")" in
    *'"name":"CI smoke test"'*) ;;
    *) fail "/current does not show the compound" ;;
esac
echo "   compound reached SuperCollider and shows on /current"

echo "== checking for errors after 15 s of the compound playing"
sleep 15
logs=$(station_logs)
case "$logs" in
    *"ERROR"* | *"FAILURE IN SERVER"*) fail "SuperCollider reported an error" ;;
esac
for c in gs-icecast gs-station gs-picker gs-caddy; do
    running=$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null || echo false)
    [ "$running" = "true" ] || fail "$c is not running"
done

echo
echo "smoke test passed"
