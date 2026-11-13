# WebRTC Test

A tiny static page to check whether peer-to-peer WebRTC works between two browsers (e.g. in different countries).

- Pick a name, see everyone online (with country flag + timezone), click **Connect**.
- Direct data-channel chat, live ping (data channel + ICE RTT), and whether the path is **Direct (P2P)** or **Relayed (TURN)**.
- Optional camera/mic sharing.
- "Network settings": force TURN-only to diagnose firewalls, or plug in your own ICE servers.
- `?room=name` gives you a private room; `?broker=wss://...` overrides the signaling brokers.

## How it works
No backend. Presence and signaling go over free public MQTT-over-WebSocket brokers (EMQX, HiveMQ, Mosquitto; it connects to all and only needs one in common). Media/data go directly browser to browser.

Privacy notes: your IP is looked up via `api.country.is` (fallback Cloudflare trace) to show your flag, and flag images come from `flagcdn.com`. Names, country and timezone are published on the public brokers under a namespaced topic. The default TURN server is a free public one and is best-effort; use your own for reliable results.

## Deploy
GitHub Pages: Settings → Pages → Source: **Deploy from a branch** → `main` / `(root)`.
