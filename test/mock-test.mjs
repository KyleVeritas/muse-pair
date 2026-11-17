// Local logic test for worker/src/worker.js with an in-memory KV stub.
// Run: node test/mock-test.mjs
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

// We need the raw tokens, but the API returns identity_token only via the
// create/join responses — capture them here exactly like pair.py does.
const health = await req("GET", "/health");
check("health", health.status === 200 && health.body.ok === true, health);

const a = await req("POST", "/pair/create", { name: "Kyle" });
check("create", a.status === 201 && a.body.code && a.body.identity_token, a);
const aTok = a.body.identity_token, room = a.body.room_id, code = a.body.code;

const bad = await req("POST", "/pair/join", { code: "MP-XXXX-XXXX", name: "Eve" });
check("bad code rejected", bad.status === 401, bad);

const b = await req("POST", "/pair/join", { code, name: "Friend" });
check("join", b.status === 200 && b.body.identity_token && b.body.peer_name === "Kyle", b);
const bTok = b.body.identity_token;

const reuse = await req("POST", "/pair/join", { code, name: "Third" });
check("code is one-time", reuse.status === 401, reuse);

const early = await req("POST", `/rooms/${room}/send`, { type: "task", text: "too early" }, bTok);
check("task blocked before active", early.status === 409, early);

const hello = await req("POST", `/rooms/${room}/send`, { type: "hello", text: "hi, I am Friend's Muse" }, bTok);
check("hello allowed while pending", hello.status === 201, hello);

const confirmByJoiner = await req("POST", `/rooms/${room}/confirm`, {}, bTok);
check("joiner cannot confirm", confirmByJoiner.status === 403, confirmByJoiner);

const conf = await req("POST", `/rooms/${room}/confirm`, {}, aTok);
check("creator confirms", conf.status === 200 && conf.body.status === "active", conf);

const task = await req("POST", `/rooms/${room}/send`, { type: "task", text: "please check Friday", context_id: "scheduling" }, aTok);
check("send task", task.status === 201, task);

let inbox = await req("GET", "/me/inbox", null, bTok);
const roomInbox = inbox.body.rooms.find((r) => r.room_id === room);
check("friend inbox has the task (own hello excluded)", inbox.status === 200 && roomInbox && roomInbox.unread === 1, inbox.body);

inbox = await req("GET", "/me/inbox", null, aTok);
const aInbox = inbox.body.rooms.find((r) => r.room_id === room);
check("creator inbox empty (own msgs excluded, hello ack flow)", aInbox && aInbox.unread === 1, inbox.body); // hello from B is unread for A

const ack = await req("POST", `/rooms/${room}/ack`, { message_ids: roomInbox.messages.map((m) => m.id) }, bTok);
check("ack", ack.status === 200 && ack.body.acked === 1, ack);

inbox = await req("GET", "/me/inbox", null, bTok);
check("inbox cleared after ack", inbox.body.unread === 0, inbox.body);

const stranger = await req("GET", "/me/inbox", null, "mp_bogus");
check("bogus token 401", stranger.status === 401, stranger);

const c = await req("POST", "/pair/create", { name: "Kyle" }, aTok);
check("second room reuses identity (no new token)", c.status === 201 && !c.body.identity_token && c.body.room_id !== room, c);
const regen = await req("POST", `/rooms/${c.body.room_id}/regenerate-code`, {}, aTok);
check("regenerate code", regen.status === 200 && regen.body.code, regen);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
