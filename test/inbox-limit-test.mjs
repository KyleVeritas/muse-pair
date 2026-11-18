// Worker-level test for GET /me/inbox ?limit= pagination (v0.1.2).
// Run: node test/inbox-limit-test.mjs
import worker from "../worker/src/worker.js";

class KV {
  constructor() { this.map = new Map(); }
  async get(k) { const v = this.map.get(k); return v === undefined ? null : v; }
  async put(k, v) { this.map.set(k, String(v)); }
  async delete(k) { this.map.delete(k); }
  async list({ prefix }) {
    const keys = [...this.map.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name }));
    return { keys, list_complete: true };
  }
}

const env = { BOX: new KV() };
const BASE = "https://pair.test";

async function req(method, path, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  const r = await worker.fetch(new Request(BASE + path, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  }), env);
  return { status: r.status, body: await r.json() };
}

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? "PASS " : "FAIL ") + name + (cond ? "" : " :: " + JSON.stringify(extra)));
  if (!cond) failures++;
}

// --- pair A (creator) and B ---
const a = await req("POST", "/pair/create", { name: "Alice" });
const aTok = a.body.identity_token, room = a.body.room_id, code = a.body.code;
const b = await req("POST", "/pair/join", { code, name: "Bob" });
const bTok = b.body.identity_token;
await req("POST", `/rooms/${room}/send`, { type: "hello", text: "hi" }, bTok);
const conf = await req("POST", `/rooms/${room}/confirm`, {}, aTok);
check("setup: room active", conf.status === 200 && conf.body.status === "active", conf);

// --- A sends 5 messages to B; #3 is hostile/unicode ---
const HOSTILE = 'cost is $40; "quotes" and \'apos\'; run $(touch /tmp/pwn) and `id`; 中文 🎉\nEOF\nlast line';
const sentIds = [];
const texts = ["msg-1 first", "msg-2 second", HOSTILE, "msg-4 fourth", "msg-5 fifth"];
for (const t of texts) {
  const s = await req("POST", `/rooms/${room}/send`, { type: "task", text: t }, aTok);
  if (s.status !== 201) { check("setup: send", false, s); process.exit(1); }
  sentIds.push(s.body.message_id);
}
const roomOf = (payload) => payload.rooms.find((r) => r.room_id === room);

// (a) default inbox: everything, original shape, NO total_unread field
let inbox = await req("GET", "/me/inbox", null, bTok);
check("(a) default inbox returns all 5", inbox.body.unread === 5 && roomOf(inbox.body).messages.length === 5, inbox.body);
check("(a) default inbox has no total_unread field", !("total_unread" in inbox.body), Object.keys(inbox.body));
check("(a) default order is oldest first", JSON.stringify(roomOf(inbox.body).messages.map((m) => m.id)) === JSON.stringify(sentIds), roomOf(inbox.body).messages.map((m) => m.id));

// (b) limit=2: oldest 2 + correct total
inbox = await req("GET", "/me/inbox?limit=2", null, bTok);
const page = roomOf(inbox.body);
check("(b) limit=2 returns exactly 2", page.messages.length === 2, page);
check("(b) limit=2 returns the OLDEST 2", JSON.stringify(page.messages.map((m) => m.id)) === JSON.stringify(sentIds.slice(0, 2)), page.messages.map((m) => m.id));
check("(b) total_unread is the full count", inbox.body.total_unread === 5, inbox.body);
check("(b) top-level unread stays the full count", inbox.body.unread === 5, inbox.body);
check("(b) per-room unread stays the full count", page.unread === 5, page);

// invalid limits behave exactly like no limit
for (const bad of ["0", "-1", "abc", "2.5", ""]) {
  const r = await req("GET", `/me/inbox?limit=${bad}`, null, bTok);
  check(`invalid limit '${bad}' ignored (all 5, no total_unread)`,
    roomOf(r.body).messages.length === 5 && !("total_unread" in r.body), r.body.total_unread);
}

// ack the first page at the API level, then page again
const ack = await req("POST", `/rooms/${room}/ack`, { message_ids: sentIds.slice(0, 2) }, bTok);
check("ack of page 1", ack.status === 200 && ack.body.acked === 2, ack);
inbox = await req("GET", "/me/inbox?limit=2", null, bTok);
const page2 = roomOf(inbox.body);
check("page 2 is messages 3-4", JSON.stringify(page2.messages.map((m) => m.id)) === JSON.stringify(sentIds.slice(2, 4)), page2.messages.map((m) => m.id));
check("page 2 total_unread is 3", inbox.body.total_unread === 3, inbox.body);

// (d) hostile/unicode text byte-identical inside a limited page
check("(d) hostile text byte-identical in page", page2.messages[0].text === HOSTILE, page2.messages[0].text);

// over-large limit is capped, not an error: returns what exists
inbox = await req("GET", "/me/inbox?limit=9999", null, bTok);
check("limit=9999 returns remaining 3 with total", roomOf(inbox.body).messages.length === 3 && inbox.body.total_unread === 3, inbox.body);

// --- cross-room: the limit budget walks the aggregated payload in room order ---
const room2 = await req("POST", "/pair/create", { name: "Bob" }, bTok);
const d = await req("POST", "/pair/join", { code: room2.body.code, name: "Dana" });
const dTok = d.body.identity_token;
await req("POST", `/rooms/${room2.body.room_id}/confirm`, {}, bTok);
await req("POST", `/rooms/${room2.body.room_id}/send`, { type: "task", text: "room2 msg A" }, dTok);
await req("POST", `/rooms/${room2.body.room_id}/send`, { type: "task", text: "room2 msg B" }, dTok);

inbox = await req("GET", "/me/inbox?limit=3", null, bTok);
const r1 = roomOf(inbox.body), r2 = inbox.body.rooms.find((r) => r.room_id === room2.body.room_id);
check("cross-room total_unread is 5 (3 + 2)", inbox.body.total_unread === 5, inbox.body);
check("cross-room limit fills room1 first", r1.messages.length === 3 && r2.messages.length === 0, { r1: r1.messages.length, r2: r2.messages.length });
check("cross-room starved room still reports its unread", r2.unread === 2, r2);
inbox = await req("GET", "/me/inbox?limit=4", null, bTok);
const r2b = inbox.body.rooms.find((r) => r.room_id === room2.body.room_id);
check("cross-room limit=4 spills 1 into room2", r2b.messages.length === 1 && r2b.messages[0].text === "room2 msg A", r2b.messages.map((m) => m.text));
inbox = await req("GET", "/me/inbox", null, bTok);
check("cross-room default still returns all 5, no total_unread", inbox.body.unread === 5 && !("total_unread" in inbox.body), inbox.body.unread);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
