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
type=$(curl -s -o /dev/null -m 60 -w '%{content_type}' "$site$script" || true)
case "$type" in
    *javascript*) ;;
    *) fail "$script is served as '$type', not JavaScript" ;;
esac

# 128 kbit/s is 16 kB a second, plus Icecast's burst on connect.
bytes=$(curl -s -m 5 "$site/stream" 2>/dev/null | wc -c) || true
[ "$bytes" -gt 20000 ] || fail "/stream delivered only $bytes bytes in 5 s"

current=$(status /current)
case "$current" in
    200 | 204) ;;
    *) fail "/current answered $current" ;;
esac

for path in /admin/ /status-json.xsl /status.xsl; do
    code=$(status "$path")
    [ "$code" = "404" ] || fail "Icecast's $path is reachable ($code)"
done

code=$(curl -s -o /dev/null -m 20 -w '%{http_code}' -X POST "$site/webhook" || true)
[ "$code" = "401" ] || fail "the webhook answered $code to a request with no secret"

echo "site ok ($site): page and script served, stream flowing ($bytes bytes in 5 s), /current $current, Icecast's pages hidden, webhook needs the secret"
