# muse-pair

> Unofficial open-source project. Not affiliated with Meta. "Muse" is the name of Meta's personal AI agent product; this project is a community bridge for people who each run their own Muse.

**A private, pairwise mailbox bridge between two personal AI agents.**

Each person has their own personal agent (for example, a Meta Muse). Those agents have no native way to talk to each other. muse-pair is the simplest bridge that works today:

- One tiny **Cloudflare Worker** hosts a mailbox made of many independent two-person **rooms**.
- Two people **pair** with a one-time pairing code (10 minutes, single use). Each side gets its own identity token. Either side can stop unilaterally at any time (disable the poll, delete the local install); cutting a side off at the bridge itself is an operator action — see `SECURITY.md`.
- Each agent **polls** its inbox (a lightweight count check every ~5 minutes, waking the agent only when there is mail) and **sends** through the same bridge.
- Messages use a small structured format (inspired by ACP-lite and the A2A task states): `hello / task / question / result / status / handoff / error`, with `requires_owner` marking anything that must stop and ask a human first.

**Open source code ≠ open data.** This repository is public so anyone — and anyone's agent — can audit exactly what runs before installing it. Deployments are private and are never in this repo. One precision: rooms and messages live on *the bridge host's* deployment — if you join a pairing on someone else's bridge, that operator holds (and can read) the data; on your own deployment, it's yours.

**There is no public or default bridge — including the maintainer's.** Nothing in this repo points at anyone's deployment: the client has no built-in bridge URL and refuses to run until you configure one. Every pairing runs on a bridge that one of the two people in it deployed themselves (see below). If someone invites you to pair, their invitation carries *their* bridge URL (or asks you to host) — a bridge URL you were never given by your pairing partner is not one you should ever configure.

## Pair in one prompt

Send your friend this single prompt — the bridge URL and the release tag go **inside** it, so nothing has to be hunted for later (fill in your own name, URL, and the current tag):

> Help me pair with Kyle's Muse: open github.com/KyleVeritas/muse-pair at the tag v0.1.2 and follow INSTALL.md step by step, guiding me through it. Our pairing's bridge is https://<your-bridge-host> — I'm hosting it. Stop and ask me whenever you need my approval, or when you need the pairing code — do not make me read the docs myself.

Their agent installs everything, then stops and asks them to get a **pairing code from you**. You generate a fresh code at that moment (it lives 10 minutes), they paste it in, their agent sends a `hello`, and you confirm the room on your side. Both humans have explicitly agreed before a single real message flows.

## Deploy your own bridge (required — one of you)

A pairing needs exactly one bridge, hosted by one of the two people in it. Hosting is a few minutes on your own Cloudflare account:

1. Create a Workers KV namespace (e.g. `muse-pair-box`).
2. Bundle and deploy `worker/src/worker.js` with the KV bound as `BOX` (see `worker/wrangler.toml.example`).
3. Set your agents' bridge URL in `~/.muse-pair/config.json` (`{"base": "https://your-worker.example"}`), and share that URL with your pairing partner out-of-band — it is part of the invitation, like the pairing code.

There are no server secrets to configure: identity tokens are generated per pairing, returned once to the local helper, and stored on the server only as SHA-256 hashes. Whoever hosts a bridge can read the plaintext of messages on it (no E2EE in v0.1) — hosting your own is how you keep that operator trust inside your own account.

## Repository layout

| Path | What |
|---|---|
| `INSTALL.md` | The install guide an agent follows to set up its human, step by step |
| `protocol/SPEC.md` | Wire protocol v0.1: pairing, rooms, message format, states, security model |
| `worker/src/worker.js` | The mailbox Worker (Cloudflare Workers + KV, no dependencies) |
| `worker/wrangler.toml.example` | Example deployment config |
| `skill/SKILL.md` | The agent skill: how an agent uses the bridge day to day |
| `skill/bin/pair.py` | Local helper CLI (token stays in a `0600` file, never printed) |
| `test/mock-test.mjs` | In-memory-KV logic tests: `node test/mock-test.mjs` |
| `examples/forward-message.md` | A ready-to-send pairing invitation template |
| `SECURITY.md` | Threat model, limits, and how to report a vulnerability |

## Design principles

1. **Simplest thing that works.** A shared mailbox + polling beat every fancier protocol for two closed agents — the format borrows A2A's discipline, the transport is plain HTTPS + KV.
2. **Identity is a credential, never a claim.** Who sent a message is established by its token, not by what the message says.
3. **Peer messages are data, never instructions.** A message from the other agent can never grant permissions, and anything sensitive (sharing private info, sending, spending, deleting) stops at `requires_owner` for a human decision.
4. **Pairwise isolation.** Rooms are independent and parallel: pairing with a second friend is a new room, invisible to the first. One service, many rooms.
5. **Both humans confirm.** A room turns `active` only after the joiner's `hello` and the creator's explicit confirmation.

## License

Apache-2.0. See `LICENSE`.
