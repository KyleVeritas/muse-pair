#!/usr/bin/env bash
# Client-level drain test for pair.py inbox --limit (v0.1.2):
# a peer with a backlog pages through it, acking exactly each displayed page.
# Run: bash test/inbox-limit.sh
set -u
cd "$(dirname "$0")/.."
PAIR="python3 skill/bin/pair.py"
PORT=$((20000 + RANDOM % 15000))
TMP=$(mktemp -d)
HA=$TMP/homeA; HB=$TMP/homeB
mkdir -p "$HA" "$HB"
FAIL=0
check() { if [ "$2" -eq 0 ]; then echo "PASS $1"; else echo "FAIL $1"; FAIL=1; fi; }

node test/e2e-server.mjs $PORT > "$TMP/srv.log" 2>&1 &
SRV=$!
cleanup() { kill $SRV 2>/dev/null; rm -rf "$TMP" /tmp/mp_pwn3; }
trap cleanup EXIT
for i in $(seq 1 40); do
  curl -s "http://127.0.0.1:$PORT/health" 2>/dev/null | grep -q '"ok":true\|"ok": true' && break
  sleep 0.5
done

echo "{\"base\": \"http://127.0.0.1:$PORT\", \"installed_ref\": \"test\"}" > "$HA/config.json"
echo "{\"base\": \"http://127.0.0.1:$PORT\", \"installed_ref\": \"test\"}" > "$HB/config.json"

CREATE=$(MUSE_PAIR_HOME=$HA $PAIR create --name "Alice")
ROOM=$(echo "$CREATE" | python3 -c "import sys,json;print(json.load(sys.stdin)['room_id'])")
CODE=$(echo "$CREATE" | python3 -c "import sys,json;print(json.load(sys.stdin)['code'])")
MUSE_PAIR_HOME=$HB $PAIR join --code "$CODE" --name "Bob" > /dev/null
MUSE_PAIR_HOME=$HB $PAIR send --room "$ROOM" --type hello --stdin > /dev/null <<'EOF'
pairing hello
EOF
MUSE_PAIR_HOME=$HA $PAIR confirm --room "$ROOM" > /dev/null

# A sends 5 messages; #3 is hostile/unicode (variable value: never re-scanned
# by the heredoc, same pattern as e2e.sh #12).
PAYLOAD='cost is $40; "quotes" and '"'"'apos'"'"'; run $(touch /tmp/mp_pwn3) and `id`; 中文 🎉'
rm -f /tmp/mp_pwn3
MUSE_PAIR_HOME=$HA $PAIR send --room "$ROOM" --type task --stdin > /dev/null <<'EOF'
msg-1 first
EOF
MUSE_PAIR_HOME=$HA $PAIR send --room "$ROOM" --type task --stdin > /dev/null <<'EOF'
msg-2 second
EOF
MUSE_PAIR_HOME=$HA $PAIR send --room "$ROOM" --type task --stdin > /dev/null <<EOF
$PAYLOAD
EOF
MUSE_PAIR_HOME=$HA $PAIR send --room "$ROOM" --type task --stdin > /dev/null <<'EOF'
msg-4 fourth
EOF
MUSE_PAIR_HOME=$HA $PAIR send --room "$ROOM" --type task --stdin > /dev/null <<'EOF'
msg-5 fifth
EOF
[ ! -e /tmp/mp_pwn3 ]; check "(d) hostile payload did not execute on send" $?

N=$(MUSE_PAIR_HOME=$HB $PAIR pending-count | python3 -c "import sys,json;print(json.load(sys.stdin)['unread'])")
[ "$N" = "5" ]; check "backlog is 5" $?

# (b) first page: oldest 2 only, with the full total alongside
PAGE=$(MUSE_PAIR_HOME=$HB $PAIR inbox --limit 2)
echo "$PAGE" | python3 -c "
import sys, json
d = json.load(sys.stdin)
msgs = [m for r in d['rooms'] for m in r['messages']]
assert [m['text'] for m in msgs] == ['msg-1 first', 'msg-2 second'], msgs
assert d.get('total_unread') == 5, d.get('total_unread')
" 2>/dev/null; check "(b) inbox --limit 2 shows oldest 2 + total_unread 5" $?

# (c) ack after the limited display acks exactly those 2
MUSE_PAIR_HOME=$HB $PAIR inbox --ack > "$TMP/ack.json"
grep -q '"acked": 2' "$TMP/ack.json"; check "(c) --ack acked exactly the 2 shown" $?
N=$(MUSE_PAIR_HOME=$HB $PAIR pending-count | python3 -c "import sys,json;print(json.load(sys.stdin)['unread'])")
[ "$N" = "3" ]; check "(c) 3 remain unread" $?

# second page carries the hostile text, byte-identical
PAGE=$(MUSE_PAIR_HOME=$HB $PAIR inbox --limit 2)
GOT=$(echo "$PAGE" | python3 -c "import sys,json; d=json.load(sys.stdin); print([m['text'] for r in d['rooms'] for m in r['messages']][0])")
[ "$GOT" = "$PAYLOAD" ]; check "(d) hostile text byte-identical in limited page" $?
MUSE_PAIR_HOME=$HB $PAIR inbox --ack > /dev/null
N=$(MUSE_PAIR_HOME=$HB $PAIR pending-count | python3 -c "import sys,json;print(json.load(sys.stdin)['unread'])")
[ "$N" = "1" ]; check "1 remains after second page ack" $?

# (a) plain inbox (no limit) still works and shows the rest
PAGE=$(MUSE_PAIR_HOME=$HB $PAIR inbox)
echo "$PAGE" | python3 -c "
import sys, json
d = json.load(sys.stdin)
msgs = [m for r in d['rooms'] for m in r['messages']]
assert [m['text'] for m in msgs] == ['msg-5 fifth'], msgs
assert 'total_unread' not in d
" 2>/dev/null; check "(a) plain inbox unchanged (rest shown, no total_unread)" $?
MUSE_PAIR_HOME=$HB $PAIR inbox --ack > /dev/null
N=$(MUSE_PAIR_HOME=$HB $PAIR pending-count | python3 -c "import sys,json;print(json.load(sys.stdin)['unread'])")
[ "$N" = "0" ]; check "backlog fully drained" $?

# non-positive limit is refused client-side and hides nothing
MUSE_PAIR_HOME=$HA $PAIR send --room "$ROOM" --type task --stdin > /dev/null <<'EOF'
msg-6 sixth
EOF
OUT=$(MUSE_PAIR_HOME=$HB $PAIR inbox --limit 0 2>/dev/null)
echo "$OUT" | grep -q 'limit_must_be_positive'; check "--limit 0 refused client-side" $?
N=$(MUSE_PAIR_HOME=$HB $PAIR pending-count | python3 -c "import sys,json;print(json.load(sys.stdin)['unread'])")
[ "$N" = "1" ]; check "refused limit hid nothing" $?

echo
if [ $FAIL -eq 0 ]; then echo "INBOX-LIMIT ALL PASS"; else echo "INBOX-LIMIT FAILURES PRESENT"; exit 1; fi
