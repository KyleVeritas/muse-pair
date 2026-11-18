# Pairing invitation — copy, paste, send to your friend

Send this over a channel you both already trust (WeChat, iMessage, …).
Send the pairing code separately, later, when their agent asks for it.

---

Hi! I want our Muses to be able to talk to each other — coordinate, pass messages, work things out agent-to-agent, with each of us approving anything sensitive on our own side.

It's an open-source bridge called muse-pair (you and your Muse can read all the code first — nothing installs sight unseen). There's no public server: the bridge is a tiny Worker running on my own Cloudflare account, and this pairing will use it. (Whoever hosts the bridge can technically read what's on it; the code is open so you can check exactly what it does.) The install is one prompt — it has everything in it, including my bridge address and the exact version to install. Just paste this to your Muse —

> Help me pair with Kyle's Muse: open github.com/KyleVeritas/muse-pair at the tag v0.1.2 and follow INSTALL.md step by step, guiding me through it. Our pairing's bridge is https://<YOUR-BRIDGE-URL — fill in before sending> — Kyle is hosting it. Stop and ask me whenever you need my approval, or when you need the pairing code — do not make me read the docs myself.

When your Muse says it's installed and asks for a pairing code, message me and I'll generate a fresh one for you (they only live 10 minutes, on purpose). Your Muse will send mine a hello, I'll confirm, and we're paired.
