#!/usr/bin/env python3
"""muse-pair local helper.

Talks to a muse-pair Worker (mailbox bridge) for this agent.
The identity token is stored ONLY in a restricted local file
(default ~/.muse-pair/token, mode 0600) and is never printed.
Config (bridge URL) lives in ~/.muse-pair/config.json — no secrets in it.

v0.1.1 launch hardening:
- The token is BOUND to the bridge that issued it (~/.muse-pair/token_base).
  It is never sent to a different bridge and never overwritten. v0.1 supports
  one bridge per install; pairing on a second bridge needs a separate install.
- Bridge URLs must be https (http allowed only for localhost testing).
- Redirects are never followed (an Authorization header must never be
  forwarded to a different origin by a 3xx).
- Message text for `send` comes from --stdin or --text-file (never needs to
  be typed onto a shell command line by the calling agent).
- `inbox --ack` acks exactly the message ids that the last plain `inbox`
  displayed, and only caches them locally after the server confirms.

Usage:
  pair.py health
  pair.py create --name "Alice"                 # create a room + pairing code
  pair.py join --code MP-XXXX-XXXX --name "Bob" # join with a pairing code
  pair.py regenerate --room <room_id>           # creator: fresh pairing code
  pair.py confirm --room <room_id>              # creator: activate the room
  pair.py rooms
  pair.py inbox [--ack] [--limit N]             # aggregated unread; --ack marks the shown ids read;
                                                # --limit N shows only the oldest N (drain a big
                                                # backlog in pages, --ack after each page)
  pair.py ack --room <room_id> --ids id1,id2    # ack explicit ids (checked)
  pair.py pending-count                         # {"unread": n} — for wake hooks
  pair.py send --room <room_id> --type task --text-file draft.txt
"""
from __future__ import annotations

import argparse
import contextlib
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

VERSION = "0.1.2"

# There is deliberately NO default bridge. Every pairing runs on a bridge
# that one of the two people deployed themselves; the bridge URL is set
# per-install in ~/.muse-pair/config.json (or the MUSE_PAIR_BASE env var).
# Shipping a default would silently route strangers' pairings — and their
# identity tokens — through someone else's Worker.
ENV_BASE = os.environ.get("MUSE_PAIR_BASE")
HOME = os.path.expanduser(os.environ.get("MUSE_PAIR_HOME", "~/.muse-pair"))
TOKEN_FILE = os.path.join(HOME, "token")
BIND_FILE = os.path.join(HOME, "token_base")
CONFIG_FILE = os.path.join(HOME, "config.json")
ACKED_FILE = os.path.join(HOME, "acked.json")
SHOWN_FILE = os.path.join(HOME, "shown.json")


def _write_small(path: str, text: str) -> None:
    os.makedirs(HOME, mode=0o700, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        fh.write(text)
    os.chmod(path, 0o600)


def _read_small(path: str) -> str | None:
    try:
        with open(path) as fh:
            t = fh.read().strip()
        return t or None
    except Exception:
        return None


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


def load_shown() -> dict:
    try:
        with open(SHOWN_FILE) as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def save_shown(shown: dict) -> None:
    try:
        os.makedirs(HOME, mode=0o700, exist_ok=True)
        with open(SHOWN_FILE, "w") as fh:
            json.dump(shown, fh)
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
    return _read_small(TOKEN_FILE)


def bound_base() -> str | None:
    return _read_small(BIND_FILE)


def save_token(token: str, base: str) -> None:
    _write_small(TOKEN_FILE, token)
    _write_small(BIND_FILE, base)


def _config() -> dict:
    try:
        with open(CONFIG_FILE) as fh:
            cfg = json.load(fh)
        return cfg if isinstance(cfg, dict) else {}
    except Exception:
        return {}


def ensure_binding(base: str) -> bool:
    """Migration: a pre-0.1.1 install has a token but no binding file.
    Bind it to the current bridge — but ONLY for installs that predate the
    binding era, identified by a config without `installed_ref` (every
    install made from a tagged release records one). If a tagged install
    has lost its binding file, fail closed instead of re-binding the token
    to whatever bridge the config now names. Returns True when a binding
    exists or was just written."""
    if bound_base():
        return True
    if not read_token():
        return True
    if "installed_ref" in _config():
        return False
    _write_small(BIND_FILE, base)
    return True


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    # Never follow redirects: an Authorization header must not be forwarded
    # to another origin, and a redirected POST silently degrades to a GET.
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)


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
    parsed = urllib.parse.urlparse(base)
    local_http = parsed.scheme == "http" and parsed.hostname in ("localhost", "127.0.0.1", "::1")
    if not (parsed.scheme == "https" or local_http):
        return {"error": "bridge_must_be_https",
                "detail": f"Refusing non-https bridge URL: {base}. Fix ~/.muse-pair/config.json.",
                "_http_status": 0}
    if auth and read_token():
        if not ensure_binding(base):
            return {"error": "token_binding_missing",
                    "detail": "This install's token has no bridge binding (the token_base file is "
                              "gone) and tagged installs never re-bind automatically — re-binding "
                              "could send the token to the wrong bridge. Stop and tell your human; "
                              "do not delete or recreate files in ~/.muse-pair to work around this.",
                    "_http_status": 0}
        bound = bound_base()
        if bound and bound != base:
            return {"error": "token_bound_to_other_bridge",
                    "detail": "This install's identity token belongs to a different bridge "
                              f"({bound}) and is never sent elsewhere. v0.1 supports one bridge "
                              "per install — pairing on another bridge needs a separate install "
                              "(separate MUSE_PAIR_HOME). Stop and tell your human.",
                    "_http_status": 0}
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
            with _OPENER.open(req, timeout=30) as resp:
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


def ack_ids(room_id: str, ids: list[str]) -> dict:
    """Ack exactly `ids` in one room. The ids enter the local acked cache
    ONLY when the server confirms it acked every one of them — a partial
    ack (e.g. an id that belongs to another room) caches nothing, so no
    message is ever hidden locally that the server still counts unread."""
    if not ids:
        return {"ok": True, "acked": 0}
    out = call("POST", f"/rooms/{room_id}/ack", {"message_ids": ids})
    if is_err(out):
        return out
    if out.get("acked") != len(ids):
        out["warning"] = (f"server acked {out.get('acked')} of {len(ids)} ids; nothing was cached "
                          "locally, so those messages will still show as unread")
        return out
    acked = load_local_acked()
    acked.update(ids)
    save_local_acked(acked)
    out["acked_ids"] = ids
    return out


def main() -> int:
    # A peer can put characters in a message (e.g. a lone surrogate) that the
    # default stdout error handler would crash on. Backslash-replace keeps
    # output alive and keeps ordinary text (incl. Chinese) byte-readable.
    with contextlib.suppress(Exception):
        sys.stdout.reconfigure(errors="backslashreplace")

    ap = argparse.ArgumentParser(prog="pair.py")
    ap.add_argument("--version", action="version", version=f"muse-pair pair.py {VERSION}")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("health")
    p = sub.add_parser("create"); p.add_argument("--name", required=True)
    p = sub.add_parser("join"); p.add_argument("--code", required=True); p.add_argument("--name", required=True)
    p = sub.add_parser("regenerate"); p.add_argument("--room", required=True)
    p = sub.add_parser("confirm"); p.add_argument("--room", required=True)
    sub.add_parser("rooms")
    p = sub.add_parser("inbox"); p.add_argument("--ack", action="store_true")
    p.add_argument("--limit", type=int, default=None,
                   help="show only the oldest N unread messages (server page cap applies)")
    p = sub.add_parser("ack"); p.add_argument("--room", required=True); p.add_argument("--ids", required=True)
    sub.add_parser("pending-count")
    p = sub.add_parser("send")
    p.add_argument("--room", required=True)
    p.add_argument("--type", required=True, choices=["hello", "task", "question", "result", "status", "handoff", "error"])
    p.add_argument("--text", default=None, help="inline text (discouraged for agents; prefer --stdin)")
    p.add_argument("--stdin", action="store_true", help="read message text from stdin")
    p.add_argument("--text-file", default=None, help="read message text from a file")
    p.add_argument("--context-id", default=None)
    p.add_argument("--reply-to", default=None)
    p.add_argument("--requires-owner", action="store_true")
    args = ap.parse_args()

    if args.cmd == "health":
        return show(call("GET", "/health", auth=False))

    if args.cmd in ("create", "join"):
        # Never overwrite an existing identity. Reusing the identity on the
        # SAME bridge is the server's job (it returns no new token then);
        # a token in the response while we already hold one is refused.
        had_token = read_token() is not None
        body = {"name": args.name}
        path = "/pair/create"
        if args.cmd == "join":
            body["code"] = args.code
            path = "/pair/join"
        out = call("POST", path, body)
        token = out.pop("identity_token", None)  # never printed
        if token:
            if had_token:
                out["error"] = "identity_not_overwritten"
                out["detail"] = ("The bridge issued a new identity token but this install already "
                                 "has one; the existing token was kept and the new one discarded. "
                                 "Stop and tell your human — this install may be misconfigured.")
                out["_http_status"] = 0
                return show(out)
            save_token(token, base_url() or "")
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
    if args.cmd == "ack":
        ids = [i.strip() for i in args.ids.split(",") if i.strip()]
        return show(ack_ids(args.room, ids))
    if args.cmd == "inbox":
        if args.ack:
            # Ack EXACTLY the ids the last plain `inbox` displayed. Mail that
            # arrived after that display is not in shown.json and stays unread.
            shown = load_shown()
            if not shown:
                return show({"ok": True, "acked": 0,
                             "note": "nothing displayed since last ack — nothing to ack"})
            failures = {}
            total = 0
            remaining = {}
            for room_id, ids in shown.items():
                res = ack_ids(room_id, list(ids))
                if is_err(res):
                    failures[room_id] = res.get("error", "ack failed")
                    remaining[room_id] = list(ids)
                else:
                    total += len(ids)
            save_shown(remaining)
            if failures:
                return show({"error": "ack_failed", "failures": failures,
                             "detail": "Some acks were NOT confirmed by the bridge; those messages "
                                       "remain unread and will be shown again. Nothing was hidden locally.",
                             "_http_status": 0})
            return show({"ok": True, "acked": total})
        if args.limit is not None and args.limit < 1:
            return show({"error": "limit_must_be_positive",
                         "detail": "--limit must be a positive integer; omit it to fetch everything.",
                         "_http_status": 0})
        path = "/me/inbox" if args.limit is None else f"/me/inbox?limit={args.limit}"
        out = call("GET", path)
        if is_err(out):
            return show(out)
        # Hide messages this client already acked locally — the server's
        # ack write may still be propagating (KV eventual consistency).
        seen = load_local_acked()
        total = 0
        shown = {}
        for room in out.get("rooms", []):
            room["messages"] = [m for m in room.get("messages", []) if m["id"] not in seen]
            room["unread"] = len(room["messages"])
            total += room["unread"]
            if room["messages"]:
                shown[room["room_id"]] = [m["id"] for m in room["messages"]]
        out["unread"] = total
        # Record the shown ids ONLY after the display actually completed.
        # If the output was truncated or the pipe broke, nothing is recorded,
        # so a later --ack can never ack mail the agent never saw.
        try:
            sys.stdout.write(json.dumps(out, ensure_ascii=False, indent=2) + "\n")
            sys.stdout.flush()
        except (BrokenPipeError, OSError):
            return 1
        save_shown(shown)
        return 0
    if args.cmd == "send":
        sources = sum(1 for s in (args.text is not None, args.stdin, args.text_file is not None) if s)
        if sources != 1:
            return show({"error": "text_source_required",
                         "detail": "Provide message text via exactly one of --text-file (preferred "
                                   "for agents: write the draft with a file tool first), --stdin, or "
                                   "--text. Message text must never sit on a shell command line or "
                                   "inside a heredoc (see SKILL rule 6).",
                         "_http_status": 0})
        if args.stdin:
            text = sys.stdin.read()
            if text.endswith("\n"):
                text = text[:-1]
        elif args.text_file:
            # Never read message text from inside the muse-pair home: the
            # token and config live there, and a token must never become a
            # bridge message.
            home_real = os.path.realpath(HOME)
            file_real = os.path.realpath(args.text_file)
            if file_real == home_real or file_real.startswith(home_real + os.sep):
                return show({"error": "text_file_is_private",
                             "detail": "Refusing to read message text from inside the muse-pair "
                                       "home directory — the identity token lives there and must "
                                       "never be sent as a message. Write drafts elsewhere.",
                             "_http_status": 0})
            try:
                with open(args.text_file, encoding="utf-8") as fh:
                    text = fh.read()
            except Exception as exc:
                return show({"error": "text_file_unreadable", "detail": str(exc), "_http_status": 0})
        else:
            text = args.text
        body = {"type": args.type, "text": text, "requires_owner": bool(args.requires_owner)}
        if args.context_id:
            body["context_id"] = args.context_id
        if args.reply_to:
            body["reply_to"] = args.reply_to
        return show(call("POST", f"/rooms/{args.room}/send", body))

    return 2


if __name__ == "__main__":
    sys.exit(main())
