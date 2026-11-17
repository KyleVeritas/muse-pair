#!/usr/bin/env bash
# End-to-end regression tests for pair.py v0.1.1 launch fixes (#5, #10, #11, #12).
# Spins two local bridges (different ports = different bridges) and drives the
# real CLI the way an agent would. Run: bash test/e2e.sh
set -u
cd "$(dirname "$0")/.."
PAIR="python3 skill/bin/pair.py"
PORT1=$((20000 + RANDOM % 15000)); PORT2=$((PORT1 + 1))
TMP=$(mktemp -d)
HA=$TMP/homeA; HB=$TMP/homeB
mkdir -p "$HA" "$HB"
FAIL=0
say() { echo "$1"; }
check() { # name, condition(0/1)
  if [ "$2" -eq 0 ]; then say "PASS $1"; else say "FAIL $1"; FAIL=1; fi
}

node test/e2e-server.mjs $PORT1 > "$TMP/srv1.log" 2>&1 &
SRV1=$!
node test/e2e-server.mjs $PORT2 > "$TMP/srv2.log" 2>&1 &
SRV2=$!
cleanup() { kill $SRV1 $SRV2 2>/dev/null; rm -rf "$TMP" /tmp/mp_pwn; }
trap cleanup EXIT
wait_health() { # port
  for i in $(seq 1 40); do
    if curl -s "http://127.0.0.1:$1/health" 2>/dev/null | grep -q '"ok":true\|"ok": true'; then return 0; fi
    sleep 0.5
  done
  echo "server on $1 never became healthy"; cat "$TMP"/srv*.log; return 1
}
wait_health $PORT1 || exit 1
wait_health $PORT2 || exit 1

echo "{\"base\": \"http://127.0.0.1:$PORT1\", \"installed_ref\": \"test\"}" > "$HA/config.json"
echo "{\"base\": \"http://127.0.0.1:$PORT1\", \"installed_ref\": \"test\"}" > "$HB/config.json"
export MUSE_PAIR_HOME=$HA

# version
V=$($PAIR --version)
[ "$V" = "muse-pair pair.py 0.1.1" ]; check "--version reports 0.1.1" $?

# --- full pairing flow ---
CREATE=$(MUSE_PAIR_HOME=$HA $PAIR create --name "Kyle")
ROOM=$(echo "$CREATE" | python3 -c "import sys,json;print(json.load(sys.stdin)['room_id'])")
CODE=$(echo "$CREATE" | python3 -c "import sys,json;print(json.load(sys.stdin)['code'])")
[ -n "$ROOM" ] && [ -n "$CODE" ]; check "create returns room+code" $?
[ -f "$HA/token_base" ]; check "token binding file written on create" $?

JOIN=$(MUSE_PAIR_HOME=$HB $PAIR join --code "$CODE" --name "Friend")
echo "$JOIN" | grep -q '"token_saved": true'; check "join saves token" $?

# hello via stdin (the documented form)
HELLO=$(MUSE_PAIR_HOME=$HB $PAIR send --room "$ROOM" --type hello --stdin <<'EOF'
Hi, I'm Friend's agent — pairing hello.
EOF
)
echo "$HELLO" | grep -q '"message_id"'; check "hello via --stdin sent" $?

MUSE_PAIR_HOME=$HA $PAIR confirm --room "$ROOM" > /dev/null; check "confirm ok" $?

# --- #12: hostile text round-trips byte-identical, nothing executes ---
rm -f /tmp/mp_pwn
PAYLOAD='cost is $40 and $4 stays; run $(touch /tmp/mp_pwn) and `touch /tmp/mp_pwn`; "quotes" and '"'"'apostrophes'"'"' and 中文 🎉'
MUSE_PAIR_HOME=$HA $PAIR send --room "$ROOM" --type task --stdin > /dev/null <<EOF
$PAYLOAD
EOF
check "hostile send exits 0" $?
[ ! -e /tmp/mp_pwn ]; check "#12 payload did not execute" $?
GOT=$(MUSE_PAIR_HOME=$HB $PAIR inbox | python3 -c "import sys,json; d=json.load(sys.stdin); print([m['text'] for r in d['rooms'] for m in r['messages'] if m['type']=='task'][0])")
[ "$GOT" = "$PAYLOAD" ]; check "#12 text byte-identical through the bridge" $?

# --- #10: ack acks exactly what was shown ---
# B has now SEEN the task (inbox above recorded shown ids). A sends a follow-up.
MUSE_PAIR_HOME=$HA $PAIR send --room "$ROOM" --type question --stdin > /dev/null <<'EOF'
follow-up that arrives after B displayed the inbox
EOF
MUSE_PAIR_HOME=$HB $PAIR inbox --ack > "$TMP/ack1.json"; check "--ack exits 0" $?
grep -q '"acked": 1' "$TMP/ack1.json"; check "#10 acked exactly the 1 shown message" $?
LEFT=$(MUSE_PAIR_HOME=$HB $PAIR pending-count | python3 -c "import sys,json;print(json.load(sys.stdin)['unread'])")
[ "$LEFT" = "1" ]; check "#10 follow-up still unread after ack" $?
MUSE_PAIR_HOME=$HB $PAIR inbox > /dev/null
MUSE_PAIR_HOME=$HB $PAIR inbox --ack > /dev/null
LEFT=$(MUSE_PAIR_HOME=$HB $PAIR pending-count | python3 -c "import sys,json;print(json.load(sys.stdin)['unread'])")
[ "$LEFT" = "0" ]; check "#10 second display+ack clears" $?

# --- #10 failure path: ack against a dead bridge fails loudly, hides nothing ---
MUSE_PAIR_HOME=$HA $PAIR send --room "$ROOM" --type status --stdin > /dev/null <<'EOF'
message that will face a failed ack
EOF
MUSE_PAIR_HOME=$HB $PAIR inbox > /dev/null   # records shown
kill $SRV1; sleep 0.5
MUSE_PAIR_HOME=$HB $PAIR inbox --ack > "$TMP/ackfail.json" 2>/dev/null
[ $? -ne 0 ]; check "#10 failed ack exits non-zero" $?
grep -q 'ack_failed' "$TMP/ackfail.json"; check "#10 failed ack reports ack_failed" $?
node test/e2e-server.mjs $PORT1 > "$TMP/srv1b.log" 2>&1 &
SRV1=$!
wait_health $PORT1 || exit 1
# NOTE: restarted server has empty KV, so the room is gone; just verify shown.json retained the ids
python3 -c "import json;d=json.load(open('$HB/shown.json'));assert d and list(d.values())[0], 'shown retained'" 2>/dev/null
check "#10 failed ack retains shown ids (nothing hidden)" $?

# --- fresh homes + fresh pair on the restarted bridge1 (old server state is gone) ---
HC=$TMP/homeC; HD=$TMP/homeD
mkdir -p "$HC" "$HD"
echo "{\"base\": \"http://127.0.0.1:$PORT1\", \"installed_ref\": \"test\"}" > "$HC/config.json"
echo "{\"base\": \"http://127.0.0.1:$PORT1\", \"installed_ref\": \"test\"}" > "$HD/config.json"
CREATE=$(MUSE_PAIR_HOME=$HC $PAIR create --name "Kyle")
ROOM=$(echo "$CREATE" | python3 -c "import sys,json;print(json.load(sys.stdin)['room_id'])")
CODE=$(echo "$CREATE" | python3 -c "import sys,json;print(json.load(sys.stdin)['code'])")
MUSE_PAIR_HOME=$HD $PAIR join --code "$CODE" --name "Friend" > /dev/null
MUSE_PAIR_HOME=$HD $PAIR send --room "$ROOM" --type hello --stdin > /dev/null <<'EOF'
hello again
EOF
MUSE_PAIR_HOME=$HC $PAIR confirm --room "$ROOM" > /dev/null
BEFORE=$(md5sum "$HD/token" | cut -d' ' -f1)

# --- #5: token never leaves its bridge ---
echo "{\"base\": \"http://127.0.0.1:$PORT2\", \"installed_ref\": \"test\"}" > "$HD/config.json"
OUT=$(MUSE_PAIR_HOME=$HD $PAIR rooms 2>/dev/null)
echo "$OUT" | grep -q 'token_bound_to_other_bridge'; check "#5 authed call to other bridge refused locally" $?
OUT=$(MUSE_PAIR_HOME=$HD $PAIR create --name "Friend" 2>/dev/null)
echo "$OUT" | grep -q 'token_bound_to_other_bridge'; check "#5 create on other bridge refused" $?
AFTER=$(md5sum "$HD/token" | cut -d' ' -f1)
[ "$BEFORE" = "$AFTER" ]; check "#5 token file untouched by other-bridge attempts" $?
echo "{\"base\": \"http://127.0.0.1:$PORT1\", \"installed_ref\": \"test\"}" > "$HD/config.json"
MUSE_PAIR_HOME=$HD $PAIR rooms > /dev/null; check "#5 original bridge still works after attempts" $?

# --- #5: non-https base rejected ---
echo "{\"base\": \"http://pair.example.com\"}" > "$HD/config.json"
OUT=$(MUSE_PAIR_HOME=$HD $PAIR health 2>/dev/null)
echo "$OUT" | grep -q 'bridge_must_be_https'; check "#5 non-https bridge rejected" $?
echo "{\"base\": \"http://127.0.0.1:$PORT1\", \"installed_ref\": \"test\"}" > "$HD/config.json"

# --- #5 migration: token without binding binds on first use ---
rm -f "$HD/token_base"
MUSE_PAIR_HOME=$HD $PAIR rooms > /dev/null; check "migration: rooms works without binding file" $?
grep -q "127.0.0.1:$PORT1" "$HD/token_base"; check "migration: binding written for current bridge" $?

# --- #11: lone surrogate from a peer does not crash inbox ---
TOK_B=$(cat "$HD/token")
python3 - "$PORT1" "$ROOM" "$TOK_B" <<'PYEOF'
import json, sys, urllib.request
port, room, tok = sys.argv[1], sys.argv[2], sys.argv[3]
body = json.dumps({"type": "status", "text": "lone surrogate here: \ud800 end"}).encode()
req = urllib.request.Request(f"http://127.0.0.1:{port}/rooms/{room}/send", data=body, method="POST")
req.add_header("Authorization", "Bearer " + tok)
req.add_header("Content-Type", "application/json")
try:
    urllib.request.urlopen(req, timeout=10)
except Exception as e:
    print("send surrogate status:", getattr(e, "code", e))
PYEOF
OUT=$(MUSE_PAIR_HOME=$HC $PAIR inbox 2>/dev/null)
[ $? -eq 0 ]; check "#11 inbox survives lone surrogate" $?
echo "$OUT" | grep -q 'lone surrogate here'; check "#11 surrogate text still readable" $?

echo
if [ $FAIL -eq 0 ]; then echo "E2E ALL PASS"; else echo "E2E FAILURES PRESENT"; exit 1; fi
