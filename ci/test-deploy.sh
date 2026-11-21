#!/bin/sh
# Tests deploy.sh against a stand-in for docker: for each kind of change it
# checks which docker commands deploy.sh runs and how it exits.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cd "$work"
mkdir bin

cat > bin/docker <<'STUB'
#!/bin/sh
echo "$*" >> "$FAKE/calls"
case "$1 $2" in
  "inspect -f")
    case "$3" in
      *Id*)        if [ -f "$FAKE/id.$4" ]; then cat "$FAKE/id.$4"; else exit 1; fi ;;
      *StartedAt*) echo "2026-01-01T00:00:00Z" ;;
      *Running*)   if [ -f "$FAKE/down.$4" ]; then echo false; else echo true; fi ;;
    esac ;;
  "compose up")
    for c in $(cat "$FAKE/recreate" 2>/dev/null); do echo "new-$c" > "$FAKE/id.$c"; done ;;
  "compose exec") if [ -f "$FAKE/picker_down" ]; then exit 1; fi ;;
  "logs --since") cat "$FAKE/station.logs" 2>/dev/null ;;
esac
exit 0
STUB
chmod +x bin/docker

failures=0

# run_case <label> <file to change | NONE> <expected exit> <expected docker calls> [setup] [pass-old]
run_case() {
    label=$1; change=$2; want_exit=$3; want_calls=$4; setup=${5:-}; pass_old=${6:-yes}
    rm -rf repo fake; mkdir fake
    FAKE="$work/fake"; export FAKE
    for c in gs-icecast gs-station gs-picker gs-caddy; do echo "id-$c" > "fake/id.$c"; done
    printf '[station] streaming. listen at ...\n[piece] all elements running\n' > fake/station.logs
    git init -q repo
    (
        cd repo
        git config user.email ci@example.invalid; git config user.name ci
        mkdir -p station picker icecast caddy web
        for f in station/piece.scd station/swells.scd picker/app.py icecast/Dockerfile caddy/Caddyfile web/index.html README.md; do echo v1 > "$f"; done
        cp "$here/deploy.sh" .
        git add -A; git commit -qm one
    )
    old=$(git -C repo rev-parse HEAD)
    if [ "$change" != NONE ]; then
        echo v2 > "repo/$change"; git -C repo commit -qam two
    fi
    eval "$setup"
    if [ "$pass_old" = yes ]; then arg=$old; else arg=""; fi
    got_exit=0
    (cd repo && PATH="$work/bin:$PATH" HEALTH_TRIES=1 HEALTH_SLEEP=0 sh ./deploy.sh $arg) > out.txt 2>&1 || got_exit=$?
    got_calls=$(grep -vE '^(inspect|logs --since|compose exec|compose ps)' fake/calls | tr '\n' ';')
    if [ "$got_exit" = "$want_exit" ] && [ "$got_calls" = "$want_calls" ]; then
        echo "ok    $label"
    else
        echo "FAIL  $label"
        echo "      exit:  got $got_exit, want $want_exit"
        echo "      calls: got  $got_calls"
        echo "             want $want_calls"
        sed 's/^/      | /' out.txt
        failures=$((failures + 1))
    fi
}

up="compose up -d;"
run_case "docs only: nothing rebuilt or restarted"   README.md          0 "$up"
run_case "web page: nothing rebuilt or restarted"    web/index.html     0 "$up"
run_case "bind-mounted .scd: restart station"        station/swells.scd 0 "compose build station;${up}compose restart station;"
run_case "station recreated: no second restart"      station/piece.scd  0 "compose build station;$up" 'echo gs-station > "$FAKE/recreate"'
run_case "icecast replaced: restart station"         icecast/Dockerfile 0 "compose build icecast;${up}compose restart station;" 'echo gs-icecast > "$FAKE/recreate"'
run_case "picker rebuilt"                            picker/app.py      0 "compose build picker;$up" 'echo gs-picker > "$FAKE/recreate"'
run_case "Caddyfile: restart caddy"                  caddy/Caddyfile    0 "${up}compose restart caddy;"
run_case "piece never reports ready: fail"           station/piece.scd  1 "compose build station;${up}compose restart station;logs --tail 60 gs-station;" 'echo "[station] streaming" > "$FAKE/station.logs"'
run_case "picker not answering: fail"                picker/app.py      1 "compose build picker;${up}logs --tail 30 gs-picker;" 'touch "$FAKE/picker_down"'
run_case "a container is down: fail"                 README.md          1 "$up" 'touch "$FAKE/down.gs-caddy"'
run_case "no previous commit: rebuild everything"    NONE               0 "compose build icecast station picker;${up}compose restart station;compose restart caddy;" "" no
run_case "first deploy: nothing to restart"          NONE               0 "compose build icecast station picker;$up" 'rm "$FAKE"/id.*; echo "gs-icecast gs-station gs-picker gs-caddy" > "$FAKE/recreate"' no

if [ "$failures" -gt 0 ]; then
    echo "$failures case(s) failed"
    exit 1
fi
echo "all deploy.sh cases passed"
