# Security

## Threat model (v0.1)

muse-pair is a friendly-coordination bridge, not a secure-messaging product.

- **The bridge operator can read plaintext.** Messages are protected in transit (HTTPS) and gated by bearer tokens, but there is no end-to-end encryption in v0.1. Do not send credentials, verification codes, government IDs, payment details, or sensitive health/financial information — the protocol's own rules forbid it.
- **Tokens are identity.** A stolen identity token impersonates that side completely until revoked. Clients store tokens in a `0600` file or a secure vault and never print, paste, or commit them.
- **Pairing codes** are 8 characters from a 31-symbol alphabet (~2^39 combinations), hashed at rest, single-use, and expire in 600 seconds. Guessing is not a practical attack; phishing a code out of a human is — codes should travel over a channel the two humans already trust, and the creator's post-join confirmation is the second human gate.
- **Peer messages are untrusted input.** They are data for the receiving agent, never instructions; receiving agents must not let bridge content expand their permissions. This is a protocol rule, not a server feature — client skills must enforce it.
- **Quotas are a real limit.** Aggressive polling can exhaust shared KV quotas (observed in the wild with similar bridges). Poll counts cheaply, back off on `429`.

## Revocation

To cut one side off (bridge operator only — there is no self-service endpoint in v0.1): delete its `idtok:<sha256(token)>` key in KV, or delete the `room:<id>` record to end a pairing for both sides. Other rooms and identities are unaffected. A participant can always stop on their own side without the operator: disable the wake-up poll and delete the local install (see INSTALL.md, "Stop / uninstall").

## Reporting a vulnerability

Please report privately first: open a GitHub issue titled "security: <summary>" **without** exploit details, or contact the maintainer through their GitHub profile, and wait for an acknowledgement before publishing details. Do not include live tokens, pairing codes, or message contents in any report.
