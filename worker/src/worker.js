// muse-pair: a private, pairwise mailbox bridge for two personal AI agents
// (e.g. two Meta Muse agents belonging to two different people).
//
// One Worker instance hosts many independent two-person "rooms".
// An identity is created only by creating a room or by joining one with a
// one-time pairing code — there is no open registration endpoint.
// Identity tokens are random, returned exactly once (to the local helper,
// which stores them in a restricted file), and stored here only as SHA-256
// hashes. Messages live in Workers KV (binding BOX) for 7 days.
//
// API (v0.1) — see protocol/SPEC.md:
//   GET  /health
//   POST /pair/create            {name}            [auth optional: reuse identity]
//   POST /pair/join              {code, name}      [auth optional: reuse identity]
//   POST /rooms/:id/regenerate-code                [auth: room creator]
//   POST /rooms/:id/confirm                        [auth: room creator]
//   GET  /me/rooms                                 [auth]
//   GET  /me/inbox                                 [auth]  (aggregated unread;
//                                                  optional ?limit=N returns only the
//                                                  oldest N, plus total_unread)
//   POST /rooms/:id/send         {type, text, context_id?, reply_to?, requires_owner?}
//   POST /rooms/:id/ack          {message_ids: []} [auth: room member]

const VERSION = "0.1.2";
const CODE_TTL_SECONDS = 600; // pairing code: 10 minutes, one-time use
const MSG_TTL_SECONDS = 60 * 60 * 24 * 7; // messages: 7 days
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L
const MSG_TYPES = ["hello", "task", "question", "result", "status", "handoff", "error"];
const MAX_TEXT = 20000;
const INBOX_PAGE_CAP = 100; // max messages one ?limit= page may return

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function b64url(bytes) {
  let s = btoa(String.fromCharCode(...new Uint8Array(bytes)));
  return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomToken(nbytes) {
  return b64url(crypto.getRandomValues(new Uint8Array(nbytes)));
}

async function sha256hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function newId(prefix) {
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(6)))
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  return prefix + "_" + Date.now().toString(36) + "_" + rand;
}

function newPairingCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let s = "";
  for (const b of bytes) s += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return "MP-" + s.slice(0, 4) + "-" + s.slice(4);
}

function bearerOf(request) {
  const auth = request.headers.get("Authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

async function identityFromToken(env, token) {
  if (!token) return null;
  const raw = await env.BOX.get("idtok:" + (await sha256hex(token)));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function createIdentity(env, name) {
  const token = "mp_" + randomToken(32);
  const rec = { id: newId("u"), name: String(name || "anonymous").slice(0, 60), rooms: [], created_at: new Date().toISOString() };
  await env.BOX.put("idtok:" + (await sha256hex(token)), JSON.stringify(rec));
  await env.BOX.put("ident:" + rec.id, JSON.stringify({ id: rec.id, name: rec.name, created_at: rec.created_at }));
  return { token, rec };
}

async function saveIdentityRooms(env, token, rec) {
  await env.BOX.put("idtok:" + (await sha256hex(token)), JSON.stringify(rec));
}

async function getRoom(env, roomId) {
  const raw = await env.BOX.get("room:" + roomId);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function saveRoom(env, room) {
  await env.BOX.put("room:" + room.id, JSON.stringify(room));
}

async function issueCode(env, roomId) {
  const code = newPairingCode();
  await env.BOX.put("code:" + (await sha256hex(code)), JSON.stringify({ room_id: roomId, created_at: new Date().toISOString() }), { expirationTtl: CODE_TTL_SECONDS });
  return code;
}

async function readBody(request) {
  try { return await request.json(); } catch { return null; }
}

async function handleCreate(request, env) {
  const body = (await readBody(request)) || {};
  const name = (body.name || "").toString().trim();
  if (!name) return json({ error: "name required" }, 400);
  let token = bearerOf(request);
  let me = await identityFromToken(env, token);
  let freshToken = null;
  if (!me) {
    const created = await createIdentity(env, name);
    me = created.rec; token = created.token; freshToken = created.token;
  }
  const room = {
    id: newId("r"),
    creator: me.id,
    members: [me.id],
    names: { [me.id]: me.name },
    status: "pending",
    next_seq: 1,
    created_at: new Date().toISOString(),
  };
  await saveRoom(env, room);
  if (!me.rooms.includes(room.id)) { me.rooms.push(room.id); await saveIdentityRooms(env, token, me); }
  const code = await issueCode(env, room.id);
  const out = { room_id: room.id, code, code_ttl_seconds: CODE_TTL_SECONDS, identity_id: me.id, status: room.status };
  if (freshToken) out.identity_token = freshToken; // returned ONCE; helper stores it, never print it
  return json(out, 201);
}

async function handleJoin(request, env) {
  const body = (await readBody(request)) || {};
  const code = (body.code || "").toString().trim().toUpperCase();
  const name = (body.name || "").toString().trim();
  if (!code || !name) return json({ error: "code and name required" }, 400);
  const codeKey = "code:" + (await sha256hex(code));
  const codeRaw = await env.BOX.get(codeKey);
  if (!codeRaw) return json({ error: "invalid_or_expired_code" }, 401);
  const room = await getRoom(env, JSON.parse(codeRaw).room_id);
  if (!room) return json({ error: "room_not_found" }, 404);
  if (room.members.length >= 2) return json({ error: "room_full" }, 409);
  let token = bearerOf(request);
  let me = await identityFromToken(env, token);
  let freshToken = null;
  if (!me) {
    const created = await createIdentity(env, name);
    me = created.rec; token = created.token; freshToken = created.token;
  }
  if (room.members.includes(me.id)) return json({ error: "already_member" }, 409);
  await env.BOX.delete(codeKey); // one-time use: burn the code on success
  room.members.push(me.id);
  room.names[me.id] = me.name;
  await saveRoom(env, room);
  if (!me.rooms.includes(room.id)) { me.rooms.push(room.id); await saveIdentityRooms(env, token, me); }
  const peerId = room.members.find((m) => m !== me.id);
  const out = { room_id: room.id, identity_id: me.id, status: room.status, peer_name: peerId ? room.names[peerId] : null };
  if (freshToken) out.identity_token = freshToken;
  return json(out, 200);
}

async function requireMember(request, env, roomId) {
  const token = bearerOf(request);
  const me = await identityFromToken(env, token);
  if (!me) return { error: json({ error: "unauthorized" }, 401) };
  const room = await getRoom(env, roomId);
  if (!room) return { error: json({ error: "room_not_found" }, 404) };
  if (!room.members.includes(me.id)) return { error: json({ error: "not_a_member" }, 403) };
  return { me, room, token };
}

async function handleRegenerate(request, env, roomId) {
  const ctx = await requireMember(request, env, roomId);
  if (ctx.error) return ctx.error;
  if (ctx.room.creator !== ctx.me.id) return json({ error: "only_creator" }, 403);
  if (ctx.room.members.length >= 2 && ctx.room.status === "active") return json({ error: "room_already_active" }, 409);
  const code = await issueCode(env, roomId);
  return json({ room_id: roomId, code, code_ttl_seconds: CODE_TTL_SECONDS });
}

async function handleConfirm(request, env, roomId) {
  const ctx = await requireMember(request, env, roomId);
  if (ctx.error) return ctx.error;
  if (ctx.room.creator !== ctx.me.id) return json({ error: "only_creator" }, 403);
  // KV is eventually consistent: a join that just landed may not be visible
  // in the room record yet. Any message in the room from a non-member is
  // proof of membership (only the joiner could have sent it, and only with
  // a valid identity) — heal the member list from messages before deciding.
  if (ctx.room.members.length < 2) {
    const msgs = await listRoomMessages(env, roomId);
    let healed = false;
    for (const e of msgs) {
      if (!ctx.room.members.includes(e.msg.from)) {
        ctx.room.members.push(e.msg.from);
        if (e.msg.from_name) ctx.room.names[e.msg.from] = e.msg.from_name;
        healed = true;
      }
    }
    if (healed) await saveRoom(env, ctx.room);
  }
  if (ctx.room.members.length < 2) return json({ error: "peer_not_joined_yet" }, 409);
  ctx.room.status = "active";
  await saveRoom(env, ctx.room);
  return json({ room_id: roomId, status: "active" });
}

async function handleSend(request, env, roomId) {
  const ctx = await requireMember(request, env, roomId);
  if (ctx.error) return ctx.error;
  const body = (await readBody(request)) || {};
  const type = MSG_TYPES.includes(body.type) ? body.type : null;
  const text = (body.text || "").toString();
  if (!type) return json({ error: "type must be one of " + MSG_TYPES.join("/") }, 400);
  if (!text.trim() || text.length > MAX_TEXT) return json({ error: "text required, max " + MAX_TEXT + " chars" }, 400);
  if (ctx.room.status !== "active" && type !== "hello") return json({ error: "room_not_active", status: ctx.room.status }, 409);
  const peerId = ctx.room.members.find((m) => m !== ctx.me.id) || null;
  const msg = {
    id: newId("m"),
    room_id: roomId,
    seq: ctx.room.next_seq++,
    from: ctx.me.id,
    from_name: ctx.room.names[ctx.me.id] || ctx.me.name,
    to: peerId,
    type,
    text,
    context_id: (body.context_id || "").toString().slice(0, 120) || null,
    reply_to: (body.reply_to || "").toString().slice(0, 120) || null,
    requires_owner: body.requires_owner === true,
    created_at: new Date().toISOString(),
    acked_by: [],
  };
  await env.BOX.put("msg:" + roomId + ":" + String(msg.seq).padStart(8, "0") + ":" + msg.id, JSON.stringify(msg), { expirationTtl: MSG_TTL_SECONDS });
  await saveRoom(env, ctx.room);
  return json({ message_id: msg.id, seq: msg.seq, room_id: roomId }, 201);
}

async function listRoomMessages(env, roomId) {
  const out = [];
  const list = await env.BOX.list({ prefix: "msg:" + roomId + ":" });
  for (const k of list.keys) {
    const raw = await env.BOX.get(k.name);
    if (!raw) continue;
    try { out.push({ key: k.name, msg: JSON.parse(raw) }); } catch { /* skip */ }
  }
  // seq can tie when two sends race a stale room record (KV eventual
  // consistency); created_at breaks ties in true chronological order.
  out.sort((a, b) => (a.msg.seq - b.msg.seq) || (a.msg.created_at < b.msg.created_at ? -1 : 1));
  return out;
}

async function handleInbox(request, env) {
  const token = bearerOf(request);
  const me = await identityFromToken(env, token);
  if (!me) return json({ error: "unauthorized" }, 401);
  // Optional pagination (v0.1.2): ?limit=N returns only the oldest N unread
  // messages across the aggregated payload — rooms in the caller's room
  // order, oldest first within each room — so a client whose harness
  // truncates large responses can drain a backlog in small pages, acking
  // each page before fetching the next. An absent or invalid limit returns
  // everything, exactly as before; a valid limit also adds `total_unread`
  // (the full unread count) to the response. Per-room `unread` always
  // reports that room's full unread count, paged or not.
  let limit = null;
  const rawLimit = new URL(request.url).searchParams.get("limit");
  if (rawLimit !== null && /^\d+$/.test(rawLimit.trim())) {
    const n = Number.parseInt(rawLimit.trim(), 10);
    if (n > 0) limit = Math.min(n, INBOX_PAGE_CAP);
  }
  let budget = limit; // null = unlimited
  const rooms = [];
  let unread = 0;
  for (const roomId of me.rooms) {
    const room = await getRoom(env, roomId);
    if (!room) continue;
    const peerId = room.members.find((m) => m !== me.id) || null;
    const msgs = await listRoomMessages(env, roomId);
    const mine = msgs.filter((e) => e.msg.from !== me.id && !e.msg.acked_by.includes(me.id)).map((e) => e.msg);
    unread += mine.length;
    // Peer-name fallback: if the room record lags (KV eventual consistency),
    // take the name from the peer's own messages.
    let peerName = peerId ? room.names[peerId] : null;
    if (!peerName) {
      const fromPeer = msgs.find((e) => e.msg.from !== me.id && e.msg.from_name);
      if (fromPeer) peerName = fromPeer.msg.from_name;
    }
    let page = mine;
    if (budget !== null) {
      page = mine.slice(0, budget);
      budget -= page.length;
    }
    rooms.push({ room_id: roomId, status: room.status, peer_name: peerName, unread: mine.length, messages: page });
  }
  const out = { identity_id: me.id, unread, rooms };
  if (limit !== null) out.total_unread = unread;
  return json(out);
}

async function handleAck(request, env, roomId) {
  const ctx = await requireMember(request, env, roomId);
  if (ctx.error) return ctx.error;
  const body = (await readBody(request)) || {};
  const ids = Array.isArray(body.message_ids) ? body.message_ids.map(String) : [];
  if (!ids.length) return json({ error: "message_ids required" }, 400);
  const msgs = await listRoomMessages(env, roomId);
  let acked = 0;
  for (const e of msgs) {
    if (ids.includes(e.msg.id) && !e.msg.acked_by.includes(ctx.me.id)) {
      e.msg.acked_by.push(ctx.me.id);
      await env.BOX.put(e.key, JSON.stringify(e.msg), { expirationTtl: MSG_TTL_SECONDS });
      acked++;
    }
  }
  return json({ acked });
}

async function handleRooms(request, env) {
  const token = bearerOf(request);
  const me = await identityFromToken(env, token);
  if (!me) return json({ error: "unauthorized" }, 401);
  const rooms = [];
  for (const roomId of me.rooms) {
    const room = await getRoom(env, roomId);
    if (!room) continue;
    const peerId = room.members.find((m) => m !== me.id) || null;
    rooms.push({ room_id: roomId, status: room.status, peer_name: peerId ? room.names[peerId] : null, created_at: room.created_at });
  }
  return json({ identity_id: me.id, name: me.name, rooms });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    if (p === "/health" && request.method === "GET") return json({ ok: true, service: "muse-pair", version: VERSION });
    if (!env.BOX) return json({ error: "server not configured: KV binding BOX missing" }, 503);
    if (p === "/pair/create" && request.method === "POST") return handleCreate(request, env);
    if (p === "/pair/join" && request.method === "POST") return handleJoin(request, env);
    if (p === "/me/rooms" && request.method === "GET") return handleRooms(request, env);
    if (p === "/me/inbox" && request.method === "GET") return handleInbox(request, env);
    const m = p.match(/^\/rooms\/([^/]+)\/(regenerate-code|confirm|send|ack)$/);
    if (m && request.method === "POST") {
      const roomId = decodeURIComponent(m[1]);
      if (m[2] === "regenerate-code") return handleRegenerate(request, env, roomId);
      if (m[2] === "confirm") return handleConfirm(request, env, roomId);
      if (m[2] === "send") return handleSend(request, env, roomId);
      if (m[2] === "ack") return handleAck(request, env, roomId);
    }
    return json({ error: "not found" }, 404);
  },
};
