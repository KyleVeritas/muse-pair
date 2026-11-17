#!/usr/bin/env python3
"""muse-pair local helper.

Talks to a muse-pair Worker (mailbox bridge) for this agent.
The identity token is stored ONLY in a restricted local file
(default ~/.muse-pair/token, mode 0600) and is never printed.
Config (bridge URL) lives in ~/.muse-pair/config.json — no secrets in it.

Usage:
  pair.py health
  pair.py create --name "Alice"                 # create a room + pairing code
  pair.py join --code MP-XXXX-XXXX --name "Bob" # join with a pairing code
  pair.py regenerate --room <room_id>           # creator: fresh pairing code
  pair.py confirm --room <room_id>              # creator: activate the room
  pair.py rooms
  pair.py inbox [--ack]                         # aggregated unread; --ack marks read
  pair.py pending-count                         # {"unread": n} — for wake hooks
  pair.py send --room <room_id> --type task --text "..." [--context-id X] [--reply-to ID] [--requires-owner]
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

# There is deliberately NO default bridge. Every pairing runs on a bridge
# that one of the two people deployed themselves; the bridge URL is set
# per-install in ~/.muse-pair/config.json (or the MUSE_PAIR_BASE env var).
# Shipping a default would silently route strangers' pairings — and their
# identity tokens — through someone else's Worker.
ENV_BASE = os.environ.get("MUSE_PAIR_BASE")
HOME = os.path.expanduser(os.environ.get("MUSE_PAIR_HOME", "~/.muse-pair"))
TOKEN_FILE = os.path.join(HOME, "token")
CONFIG_FILE = os.path.join(HOME, "config.json")
ACKED_FILE = os.path.join(HOME, "acked.json")


def load_local_acked() -> set:
    try:
        with open(ACKED_FILE) as fh:
            return set(json.load(fh))
    except Exception:
        return set()


def save_local_acked(ids: set) -> None:
    try:
        os.makedirs(HOME, mode=0o700, exist_ok=True)
        with open(ACKED_FILE, "w") as fh:
            json.dump(sorted(ids)[-2000:], fh)
    except Exception:
        pass


def visible_unread(inbox_payload: dict) -> int:
    seen = load_local_acked()
    total = 0
    for room in inbox_payload.get("rooms", []):
        total += sum(1 for m in room.get("messages", []) if m["id"] not in seen)
    return total


def base_url() -> str | None:
    try:
        with open(CONFIG_FILE) as fh:
            cfg = json.load(fh)
        if cfg.get("base"):
            return str(cfg["base"]).rstrip("/")
    except Exception:
        pass
    if ENV_BASE:
        return ENV_BASE.rstrip("/")
    return None


NO_BRIDGE = {
    "error": "no_bridge_configured",
    "detail": "No bridge URL is configured, and muse-pair has no default bridge by design. "
              "Set the bridge for this pairing in ~/.muse-pair/config.json as "
              "{\"base\": \"https://<bridge-host>\"} — the bridge is a Worker that one of the two "
              "people in the pairing deployed themselves (see the repo's README self-host section).",
    "_http_status": 0,
}


def read_token() -> str | None:
    try:
        with open(TOKEN_FILE) as fh:
            t = fh.read().strip()
        return t or None
    except Exception:
        return None


def save_token(token: str) -> None:
    os.makedirs(HOME, mode=0o700, exist_ok=True)
    fd = os.open(TOKEN_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        fh.write(token)
    os.chmod(TOKEN_FILE, 0o600)


def call(method: str, path: str, body: dict | None = None, auth: bool = True) -> dict:
    # Retry once on connection-level failures only for idempotent calls
    # (GET, ack, confirm). Sends/creates/joins are never auto-retried —
    # a retry after a lost response could duplicate them.
    idempotent = method == "GET" or path.endswith("/ack") or path.endswith("/confirm")
    attempts = 2 if idempotent else 1
    last_exc = None
    base = base_url()
    if not base:
        return dict(NO_BRIDGE)
    for attempt in range(attempts):
        url = base + path
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        # Cloudflare's edge drops some bare programmatic user-agents (error 1010 /
        # connection reset); a descriptive compatible UA passes reliably.
        req.add_header("User-Agent", "Mozilla/5.0 (compatible; muse-pair/0.1; +https://github.com/KyleVeritas/muse-pair)")
        if data is not None:
            req.add_header("Content-Type", "application/json")
        if auth:
            tok = read_token()
            if tok:
                req.add_header("Authorization", "Bearer " + tok)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read().decode())
        except urllib.error.HTTPError as exc:
            try:
                payload = json.loads(exc.read().decode())
            except Exception:
                payload = {"error": f"http {exc.code}"}
            payload["_http_status"] = exc.code
            return payload
        except Exception as exc:  # connection reset, timeout, DNS blip
            last_exc = exc
            if attempt + 1 < attempts:
                time.sleep(2)
    return {"error": f"network: {last_exc}", "_http_status": 0}


def is_err(out: dict) -> bool:
    return out.get("_http_status", 200) >= 300 or "error" in out and "_http_status" in out


def show(out: dict) -> int:
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 1 if is_err(out) else 0


def main() -> int:
    ap = argparse.ArgumentParser(prog="pair.py")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("health")
    p = sub.add_parser("create"); p.add_argument("--name", required=True)
    p = sub.add_parser("join"); p.add_argument("--code", required=True); p.add_argument("--name", required=True)
    p = sub.add_parser("regenerate"); p.add_argument("--room", required=True)
    p = sub.add_parser("confirm"); p.add_argument("--room", required=True)
    sub.add_parser("rooms")
    p = sub.add_parser("inbox"); p.add_argument("--ack", action="store_true")
    sub.add_parser("pending-count")
    p = sub.add_parser("send")
    p.add_argument("--room", required=True)
    p.add_argument("--type", required=True, choices=["hello", "task", "question", "result", "status", "handoff", "error"])
    p.add_argument("--text", required=True)
    p.add_argument("--context-id", default=None)
    p.add_argument("--reply-to", default=None)
    p.add_argument("--requires-owner", action="store_true")
    args = ap.parse_args()

    if args.cmd == "health":
        return show(call("GET", "/health", auth=False))

    if args.cmd in ("create", "join"):
        body = {"name": args.name}
        path = "/pair/create"
        if args.cmd == "join":
            body["code"] = args.code
            path = "/pair/join"
        out = call("POST", path, body)
        token = out.pop("identity_token", None)  # never printed
        if token:
            save_token(token)
            out["token_saved"] = True
        return show(out)

    if args.cmd == "regenerate":
        return show(call("POST", f"/rooms/{args.room}/regenerate-code", {}))
    if args.cmd == "confirm":
        # KV is eventually consistent: a join seconds ago may not be visible
        # to the confirm read yet. Retry only that one error, with backoff.
        out = call("POST", f"/rooms/{args.room}/confirm", {})
        attempts = 1
        while out.get("error") == "peer_not_joined_yet" and attempts < 13:
            time.sleep(5)
            out = call("POST", f"/rooms/{args.room}/confirm", {})
            attempts += 1
        if attempts > 1:
            out["confirm_attempts"] = attempts
        return show(out)
    if args.cmd == "rooms":
        return show(call("GET", "/me/rooms"))
    if args.cmd == "pending-count":
        out = call("GET", "/me/inbox")
        if is_err(out):
            return show(out)
        print(json.dumps({"unread": visible_unread(out)}))
        return 0
    if args.cmd == "inbox":
        out = call("GET", "/me/inbox")
        if is_err(out):
            return show(out)
        if args.ack:
            acked_ids = load_local_acked()
            for room in out.get("rooms", []):
                ids = [m["id"] for m in room.get("messages", [])]
                if ids:
                    call("POST", f"/rooms/{room['room_id']}/ack", {"message_ids": ids})
                    acked_ids.update(ids)
            save_local_acked(acked_ids)
            out["acked"] = True
        else:
            # Hide messages this client already acked locally — the server's
            # ack write may still be propagating (KV eventual consistency).
            seen = load_local_acked()
            total = 0
            for room in out.get("rooms", []):
                room["messages"] = [m for m in room.get("messages", []) if m["id"] not in seen]
                room["unread"] = len(room["messages"])
                total += room["unread"]
            out["unread"] = total
        return show(out)
    if args.cmd == "send":
        body = {"type": args.type, "text": args.text, "requires_owner": bool(args.requires_owner)}
        if args.context_id:
            body["context_id"] = args.context_id
        if args.reply_to:
            body["reply_to"] = args.reply_to
        return show(call("POST", f"/rooms/{args.room}/send", body))

    return 2


if __name__ == "__main__":
    sys.exit(main())
