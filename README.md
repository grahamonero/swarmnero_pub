# Swarmnero

**A peer-to-peer social network with Monero integration.**

No servers. No algorithms. No middlemen. Just you and your network.

![Platform](https://img.shields.io/badge/platform-Pear%20Runtime-orange)
![License](https://img.shields.io/badge/license-MIT-blue)

## What is Swarmnero?

Swarmnero is a decentralized social network built on [Pear Runtime](https://pears.com) (Holepunch). Your posts, identity, and data live on your device and sync directly with peers. There are no central servers collecting your data or algorithms deciding what you see.

### Key Features

- **True P2P Architecture** — Posts sync directly between peers via Hyperswarm DHT
- **Monero Tipping** — Send tips directly to creators, no payment processors
- **End-to-End Encrypted DMs** — Private messages between mutual followers
- **Supporter Directory** — Discover other users who support the project
- **Friend-of-Friend Discovery** — Find interesting people through your network
- **Hashtag Search** — Discover content via tags across your social graph
- **Multi-Account Support** — Multiple identities per device with optional encryption

## Getting Started

### Prerequisites

- [Pear Runtime](https://pears.com) installed
- Node.js 18+

### Run the App

```bash
# Clone the repo
git clone https://github.com/grahamonero/swarmnero.git
cd swarmnero

# Install dependencies
npm install

# Run with Pear
pear run --dev .
```

Or use the npm script:

```bash
npm run dev
```

## How It Works

```
[Your Device] ←—Hyperswarm DHT—→ [Peer Devices]
      │
      ├── Hypercore (append-only feed for posts)
      ├── Hyperdrive (media storage)
      └── Monero Wallet (via monero-ts WASM)
              │
              └──→ Remote Monero Nodes (for sync/send)
```

**Identity**: Ed25519 keypair stored locally. Your public key is your identity.

**Swarm ID**: A 64-character hex string you share so others can follow you.

**Feeds**: Each user has a Hypercore append-only log. When you follow someone, their feed replicates to your device.

**Wallet**: Built-in Monero wallet using monero-ts WASM. Create, restore, send, and receive XMR.

## Features

### Social
- Post text, images, videos, and file attachments
- Like, reply, and repost
- Markdown formatting with emoji support
- Delete posts (soft delete)

### Tipping
- Tip any post with Monero
- Each post gets a unique subaddress for tracking
- Tips are instant and go directly to the creator

### Direct Messages
- E2E encrypted using X25519 Diffie-Hellman
- Requires mutual follow (both parties follow each other)
- Messages sync when peers reconnect

### Discovery
- **Live Now**: See who's online via DHT
- **Supporters**: Directory of users backing development ($12/year in XMR)
- **Friend-of-Friend**: Discover content from people your follows follow

## Privacy

- No servers store your data
- No tracking or analytics
- DM topics are hashed to prevent pubkey exposure
- Wallet connects to public Monero nodes (your IP is visible to nodes)

## Contributing

Contributions welcome. Please open an issue first to discuss changes.

## License

MIT

---

*See you in the swarm.*
