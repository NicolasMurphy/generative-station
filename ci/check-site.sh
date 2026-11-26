#!/bin/sh
# Checks the site from the outside, the way a listener's browser sees it.
#
#   sh ci/check-site.sh https://station.example.com
#
# Used against the real site after every deploy (from the CI runner, so TLS,
# Caddy and the stream are all in the path) and against the local stack by
# the smoke test.
set -eu
site=${1:?usage: check-site.sh <base url>}

fail() {
    echo "SITE CHECK FAILED ($site): $1"
    exit 1
}
status() {
    curl -s -o /dev/null -m 20 -w '%{http_code}' "$site$1" || true
}

page=$(curl -fsS -m 20 "$site/") || fail "the page did not load"
case "$page" in
    *"<title>generative-station</title>"*) ;;
    *) fail "/ is not the station page" ;;
esac

script=$(printf '%s\n' "$page" | sed -n 's/.*"three": "\([^"]*\)".*/\1/p')
[ -n "$script" ] || fail "the page does not name its visualiser script"
for path in "$script" /viz-bloom.js /viz-sand.js /viz-reaction.js /viz-trace.js /viz-aurora.js /viz-pool.js /viz-magnet.js /viz-ink.js /viz-ferro.js /viz-crystal.js /viz-jellyfish.js /viz-rings.js; do
    type=$(curl -s -o /dev/null -m 60 -w '%{content_type}' "$site$path" || true)
    case "$type" in
        *javascript*) ;;
        *) fail "$path is served as '$type', not JavaScript" ;;
    esac
done

# The tab's icon, the home-screen icon, the cover a lock screen falls
# back to, and the picture shown where a link to the station is passed on.
card=$(printf '%s\n' "$page" | sed -n 's/.*property="og:image" content="[a-z]*:\/\/[^/"]*\([^"]*\)".*/\1/p')
[ -n "$card" ] || fail "the page does not name the picture for a link to it"
for path in /icon.svg /icon-32.png /icon-180.png /icon-512.png "$card"; do
    type=$(curl -s -o /dev/null -m 20 -w '%{content_type}' "$site$path" || true)
    case "$type" in
        image/*) ;;
        *) fail "$path is served as '$type', not an image" ;;
    esac
done

# 128 kbit/s is 16 kB a second, plus Icecast's burst on connect.
bytes=$(curl -s -m 5 "$site/stream" 2>/dev/null | wc -c) || true
[ "$bytes" -gt 20000 ] || fail "/stream delivered only $bytes bytes in 5 s"

current=$(status /current)
case "$current" in
    200 | 204) ;;
    *) fail "/current answered $current" ;;
esac

# The picker asks Icecast about the stream every few seconds, so right after
# a restart it may not know yet; give it a moment.
tries=0
while :; do
    stats=$(curl -fsS -m 20 "$site/stats") || fail "/stats did not answer"
    case "$stats" in
        *'"visits":'*'"listeners":'* | *'"listeners":'*'"visits":'*) ;;
        *) fail "/stats is missing its counters: $stats" ;;
    esac
    case "$stats" in
        *'"stream_started":null'*) ;;
        *) break ;;
    esac
    tries=$((tries + 1))
    [ "$tries" -lt 5 ] || fail "/stats does not know when the stream started"
    sleep 3
done

for path in /admin/ /status-json.xsl /status.xsl; do
    code=$(status "$path")
    [ "$code" = "404" ] || fail "Icecast's $path is reachable ($code)"
done

code=$(curl -s -o /dev/null -m 20 -w '%{http_code}' -X POST "$site/webhook" || true)
[ "$code" = "401" ] || fail "the webhook answered $code to a request with no secret"

echo "site ok ($site): page and script served, stream flowing ($bytes bytes in 5 s), /current $current, /stats live, Icecast's pages hidden, webhook needs the secret"
