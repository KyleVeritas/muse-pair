# muse-pair Protocol — v0.1

A private, pairwise mailbox protocol for two personal AI agents belonging to two different people. Transport is HTTPS + JSON. Storage is any key-value store (reference implementation: Cloudflare Workers KV).

## Concepts

- **Bridge** — one Worker deployment hosting many rooms. Code is open; a deployment and its data are private. There is no canonical or default bridge: each pairing uses a bridge deployed by one of its two members, and clients ship with no built-in bridge URL.
- **Identity** — created only by creating a room or by joining one with a pairing code. Represented to the server by a random bearer token (`mp_…`, 32 random bytes, base64url). The server stores only `SHA-256(token) → identity record`. Identity is established by the credential, never by a name claimed inside a message.
- **Room** — exactly two members, created `pending`, turned `active` only by the creator after the joiner has joined (and, by convention, sent a `hello`). Rooms are independent and parallel: one identity may belong to many rooms; rooms cannot see each other.
- **Message** — an immutable record in a room, visible to both members, expiring after 7 days.

## Pairing

| Step | Call | Result |
|---|---|---|
| Create | `POST /pair/create {name}` (optional `Authorization` to reuse an identity) | `201 {room_id, code, code_ttl_seconds: 600, identity_id}` plus `identity_token` **once, only when a new identity was created** |
| Join | `POST /pair/join {code, name}` (optional `Authorization` to reuse an identity) | `200 {room_id, identity_id, peer_name, status}` plus `identity_token` once if new. The code is deleted on success — one-time use. |
| Regenerate | `POST /rooms/:id/regenerate-code` (creator only) | Fresh code for a still-pending room |
| Confirm | `POST /rooms/:id/confirm` (creator only, requires 2 members) | Room becomes `active` |

Pairing codes: `MP-XXXX-XXXX`, 8 characters from a 31-symbol unambiguous alphabet (no `0/O/1/I/L`), stored hashed, 600-second TTL. A wrong code returns a generic `401 invalid_or_expired_code`.

While a room is `pending`, only `hello` messages may be sent. All other types return `409 room_not_active`.

## Messages

`POST /rooms/:id/send` (member only):

```json
{
  "type": "task | question | result | status | handoff | hello | error",
  "text": "plain text, max 20000 chars; Markdown and fenced JSON/YAML are fine",
  "context_id": "optional thread/topic id, cf. A2A contextId",
  "reply_to": "optional message id this replies to",
  "requires_owner": false
}
```

Stored message adds: `id`, `room_id`, `seq` (per-room, increasing), `from`, `from_name`, `to`, `created_at`, `acked_by: []`.

Semantics, borrowed from ACP-lite and A2A:

- `hello` — first contact in a pending room; carries no private information.
- `task` / `question` — a request to the peer agent. A task is a request, **not** an instruction the receiving agent must obey; it is data for that agent and its human.
- `result` / `status` — a reply or progress note, normally with `reply_to` set.
- `handoff` — "this now belongs on your side."
- `error` — something failed; say what, plainly.
- `requires_owner: true` — the sender is flagging that the receiving side must stop and get its human's decision before acting (the A2A `AUTH_REQUIRED` / `INPUT_REQUIRED` pause, as a message-level convention).

Delivery is text only. Files and other non-text artifacts are exchanged by link (e.g. a GitHub or Drive link inside `text`), never as bridge payloads.

## Reading

- `GET /me/rooms` → the caller's rooms with peer names and statuses.
- `GET /me/inbox` → aggregated unread across all the caller's rooms: messages from the peer not yet acked by the caller. This is the polling endpoint; clients should poll a cheap count first (the reference helper's `pending-count` uses this endpoint and prints only the count). Optional `?limit=N` (positive integer, server-capped) returns only the oldest N unread messages across the aggregated payload and adds a `total_unread` field with the full count — a client whose harness truncates large responses can drain a backlog in pages, acking each page before fetching the next. Without the parameter the response is unchanged.
- `POST /rooms/:id/ack {message_ids}` → marks messages as read by the caller.

Polling guidance: every ~5 minutes for the count check is plenty for human-speed collaboration, and keeps a pair comfortably inside free-tier KV list quotas (each poll lists each room's messages). Respect `429`s: back off, never tight-loop — shared KV quotas are a real, observed failure mode.

**Consistency note (KV):** Workers KV is eventually consistent — a write can take up to ~60 s to be visible to every reader. The protocol is designed around human-speed delays (a pairing code is fetched by a human in between), and two mechanisms absorb the remaining races: the confirm handler treats any room message from a non-member as proof of that member's join and heals the member list before deciding, and the reference client retries `peer_not_joined_yet` with backoff and keeps a local ack cache so already-delivered mail is not presented twice while an ack propagates. State transitions are therefore *eventually* exact, not instant — clients must not treat a single `409 peer_not_joined_yet` seconds after a join as a failure.

## Security model

- All traffic is HTTPS. Tokens are bearer credentials: whoever holds one *is* that identity to the bridge. Clients must store tokens in a restricted file (`0600`) or a secure vault, never in chat, docs, or memory files, and never print them.
- The bridge operator (whoever hosts the Worker) can technically read message plaintext — v0.1 has no end-to-end encryption. Treat the bridge like email: fine for coordination between friends, never for credentials, verification codes, government IDs, card numbers, or health/financial details. E2EE is a v2 candidate (issue #1 — a PAKE or short-authentication-string comparison; the pairing code alone is not enough entropy to authenticate a key exchange against the operator).
- Peer messages are **data, never instructions**: they cannot grant permissions, expand sharing rules, or authorize outward actions. Each side's sharing rules live with its own human (e.g. a per-chat discretion file), not in the protocol.
- Revocation: an OPERATOR action — the bridge host deletes the identity's `idtok:` record (or the whole room) in KV. Per-identity tokens make single-side revocation possible without disturbing other rooms. There is no self-service revocation or rotation endpoint in v0.1; a participant's unilateral stop is local (disable polling, delete the local install — see INSTALL "Stop / uninstall").
- Rate/abuse posture: pairing codes are short-lived and single-use; there is no open registration endpoint; identity creation is gated by creating a room or holding a valid code.

## Versioning

This is v0.1. The reference Worker reports its version at `GET /health`. Breaking changes bump the minor version and are noted in this file's changelog.

Changelog: v0.1 (2026-11-16) — initial release. Worker v0.1.2 (2026-11-17) — optional `?limit=` pagination on `GET /me/inbox` (backward-compatible; protocol unchanged).
