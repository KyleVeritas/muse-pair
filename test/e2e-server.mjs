// Throwaway local HTTP wrapper around the worker for pair.py end-to-end tests.
// Usage: node test/e2e-server.mjs <port>   (in-memory KV, no persistence)
import http from "node:http";
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
const port = Number(process.argv[2] || 8787);

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  const url = `http://127.0.0.1:${port}${req.url}`;
  const request = new Request(url, {
    method: req.method,
    headers: req.headers,
    body: ["GET", "HEAD"].includes(req.method) ? undefined : body,
  });
  try {
    const r = await worker.fetch(request, env);
    const buf = Buffer.from(await r.arrayBuffer());
    res.writeHead(r.status, Object.fromEntries(r.headers.entries()));
    res.end(buf);
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "server_exception", detail: String(e) }));
  }
});
server.listen(port, "127.0.0.1", () => console.log(`e2e bridge on ${port}`));
