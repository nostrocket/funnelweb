# Nostr Development Patterns

A complete reference for building Nostr systems and apps — covering event structure, relay management, signing, publishing, and operational concerns.

This document covers both TypeScript/JS (nostr-tools) and Go (go-nostr) patterns. The **Go / go-nostr** sections reflect what is actually used in this codebase (DeepFry).

---

## Table of Contents

1. [Event Structure](#1-event-structure)
2. [Event Kinds and Storage Semantics](#2-event-kinds-and-storage-semantics)
3. [Common Tag Formats](#3-common-tag-formats)
4. [Creating Events](#4-creating-events)
5. [Signing Events](#5-signing-events)
6. [Publishing Events](#6-publishing-events)
7. [Subscriptions](#7-subscriptions)
8. [Relay Discovery](#8-relay-discovery)
9. [Relay Metrics & Purging](#9-relay-metrics--purging)
10. [Connection Management](#10-connection-management)
11. [General Best Practices & Gotchas](#11-general-best-practices--gotchas)
12. [Go / go-nostr — Event Patterns](#12-go--go-nostr--event-patterns)
13. [Go / go-nostr — Relay & Connection Management](#13-go--go-nostr--relay--connection-management)
14. [StrFry Plugin Protocol (stdin/stdout JSON)](#14-strfry-plugin-protocol-stdinstdout-json)
15. [Quarantine Pattern](#15-quarantine-pattern)
16. [Go-Specific Gotchas](#16-go-specific-gotchas)

---

## Libraries

### go-nostr (Go)

```
go get github.com/nbd-wtf/go-nostr
```

The reference Go library for Nostr. Covers the full protocol: key derivation, event creation, signing, signature verification, relay connections over WebSockets, and subscriptions with Go channels for event delivery. Includes sub-packages for NIP-specific logic (nip11, nip19, nip42, etc.).

**Use it for:** all Nostr protocol work in Go. It is the only Nostr library used in this codebase.

Key exports used in this project:

| Export | Purpose |
|---|---|
| `nostr.Event` | Core event struct (`ID`, `PubKey`, `CreatedAt`, `Kind`, `Tags`, `Content`, `Sig`) |
| `nostr.Filter` | Subscription filter (`Kinds`, `Authors`, `Since`, `Until`, `Limit`, `Tags`) |
| `nostr.Timestamp` | `int64` alias for Unix seconds; use `nostr.Now()` for current time |
| `nostr.Tags` / `nostr.TagMap` | Slice/map helpers for working with event tags |
| `nostr.RelayConnect(ctx, url)` | Dial a relay over WebSocket; returns `*nostr.Relay` |
| `relay.Subscribe(ctx, filters, opts)` | Open a subscription; returns `*nostr.Subscription` |
| `relay.Publish(ctx, event)` | Publish an event; returns error on rejection or timeout |
| `relay.Close()` | Close the relay connection |
| `event.Sign(skHex)` | Sign an event with a hex-encoded 32-byte private key; sets `ID` and `Sig` |
| `event.CheckSignature()` | Validate `ID` (SHA-256 of canonical serialization) and Schnorr `Sig` |
| `nostr.GetPublicKey(skHex)` | Derive hex pubkey from hex private key |
| `nostr.NormalizeURL(url)` | Normalize relay URL (lowercase scheme/host, strip trailing slash) |
| `nip19.Decode(bech32)` | Decode `nsec1…` / `npub1…` / `note1…` to prefix + raw bytes |
| `nip19.EncodePrivateKey(hex)` | Encode 32-byte hex private key to `nsec1…` |
| `nip19.EncodePublicKey(hex)` | Encode 32-byte hex pubkey to `npub1…` |
| `nip11.Fetch(ctx, relayURL)` | Fetch the NIP-11 relay information document |

**Subscription channels:**

| Channel | Description |
|---|---|
| `sub.Events` | `chan *nostr.Event` — receives matching events |
| `sub.EndOfStoredEvents` | `chan struct{}` — closed once the relay sends EOSE |
| `sub.Context.Done()` | Closed when the subscription context is cancelled |
| `sub.ClosedReason` | Set if the relay sends a CLOSED message |

---

### nostr-tools

```
npm install nostr-tools
```

The reference TypeScript/JS library for Nostr. Covers the full event lifecycle — key generation, event creation, signing, ID computation, and signature verification — plus NIP-specific helpers (NIP-04 encrypted DMs, NIP-05 identifier lookup, NIP-19 bech32 encoding, NIP-49 key encryption, and more).

**Use it for:** everything unless you need higher-level relay management or remote signing. The code examples throughout this document use `nostr-tools` as the default.

Key exports used in this project:

| Export | Purpose |
|---|---|
| `generateSecretKey()` | Generates a cryptographically secure 32-byte private key using `crypto.getRandomValues` |
| `getPublicKey(sk)` | Derives the x-only 32-byte pubkey (hex) from a secret key |
| `finalizeEvent(template, sk)` | Computes the canonical event ID and Schnorr signature; returns a complete, ready-to-publish event |
| `verifyEvent(event)` | Validates event ID (SHA-256 of canonical serialization) and Schnorr signature — always call before storing or forwarding |
| `nip49.encrypt(sk, password)` | Password-encrypts a secret key to an `ncryptsec1…` string safe to persist |
| `nip49.decrypt(ncryptsec, password)` | Recovers the secret key from an encrypted string |

---

### @nostr-dev-kit/ndk

```
npm install @nostr-dev-kit/ndk
```

NDK (Nostr Development Kit) is a higher-level framework built on top of raw WebSocket/relay primitives. It handles relay pooling, subscription multiplexing, caching, and signer abstraction behind a unified API, so you don't manage individual WebSocket connections yourself.

**Use it for:** applications that need NIP-46 remote signing (`NDKNip46Signer`), or when you want managed relay connections and an event store without writing all the connection logic by hand. If you're building raw relay infrastructure or need full control over the wire protocol, talk to relays directly instead.

Key export used in this project:

| Export | Purpose |
|---|---|
| `NDKNip46Signer` | Connects to a NIP-46 bunker (`bunker://…` URL), negotiates the signing session over a relay, and signs events remotely — the app never sees the private key |

---

### @noble/hashes

```
npm install @noble/hashes
```

A zero-dependency, audited cryptographic primitives library. Provides SHA-2, SHA-3, BLAKE, RIPEMD, HMAC, HKDF, and encoding utilities implemented in pure TypeScript with no native bindings — works in browser, Node, Deno, and edge runtimes.

**Use it for:** manual event ID computation when you need to hash the canonical serialization yourself, or any other low-level hashing outside of `nostr-tools`. If you're using `finalizeEvent` or `verifyEvent` from `nostr-tools`, you don't need to call `@noble/hashes` directly — `nostr-tools` uses it internally.

Key exports used in this project:

| Export | Purpose |
|---|---|
| `sha256` from `@noble/hashes/sha256` | SHA-256 hash function — used to hash the canonical event serialization to produce the event ID |
| `bytesToHex` from `@noble/hashes/utils` | Converts a `Uint8Array` to a lowercase hex string — used to format the resulting hash as the event `id` field |

---

## 1. Event Structure

Every Nostr event is an immutable, cryptographically signed JSON object:

```typescript
interface NostrEvent {
  id: string;          // SHA-256 of canonical serialization (hex)
  pubkey: string;      // author's x-only public key (hex, 64 chars)
  created_at: number;  // Unix timestamp in seconds (NOT milliseconds)
  kind: number;        // event type (0–39999)
  tags: string[][];    // array of tag arrays
  content: string;     // arbitrary UTF-8 string
  sig: string;         // Schnorr signature (hex)
}
```

**Critical**: `created_at` must be seconds. Using `Date.now()` (milliseconds) is a common bug — use `Math.floor(Date.now() / 1000)`.

---

## 2. Event Kinds and Storage Semantics

| Kind Range | Type | Persistence | Examples |
|---|---|---|---|
| 0 | Replaceable | Latest per `pubkey+kind` | User profile |
| 1 | Regular | Each stored independently | Text notes |
| 3 | Replaceable | Latest per `pubkey+kind` | Follow list |
| 4 | Regular | Each stored | Encrypted DMs |
| 5 | Regular | Each stored | Event deletion request |
| 6 | Regular | Each stored | Repost |
| 7 | Regular | Each stored | Reactions |
| 10002 | Replaceable | Latest per `pubkey+kind` | NIP-65 relay list |
| 20000–29999 | Ephemeral | Not stored | Transient signals |
| 22242 | Ephemeral | Not stored | NIP-42 auth |
| 10000–19999 | Replaceable | Latest per `pubkey+kind` | General replaceable |
| 30000–39999 | Addressable | Latest per `pubkey+kind+d-tag` | Long-form articles |

- **Addressable events** must have a `d` tag. The `d` value is the unique identifier within `pubkey+kind`. An empty `d` tag (`["d", ""]`) is valid.
- **Replaceable events** with old timestamps are silently discarded by relays. Always use the current time.
- **Kind 5 (deletion)** is advisory — relays are not required to honour it.

---

## 3. Common Tag Formats

```typescript
["e", "<event-id>", "<relay-hint>", "<marker>"]  // marker: "root", "reply", "mention"
["p", "<pubkey>", "<relay-hint>"]                 // person reference
["a", "30023:<pubkey>:<d>", "<relay-hint>"]       // addressable event reference
["t", "bitcoin"]                                  // hashtag
["r", "wss://relay.example.com", "read"]          // relay (kind 10002); also "write", or omit for both
["d", "<identifier>"]                             // addressable event key
```

Relay hints in `e` and `p` tags (third element) drive decentralized relay discovery — clients use them to find where to fetch referenced events and users.

Tag order within an event matters for some NIPs. For `e` tags in replies, position and marker field signal thread structure. Check the relevant NIP before reordering.

---

## 4. Creating Events

### Building an Event

**✅ Use `finalizeEvent` from nostr-tools**

```typescript
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";

const sk = generateSecretKey();
const pk = getPublicKey(sk);

const event = finalizeEvent(
  {
    kind: 1,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["t", "nostr"]],
    content: "Hello, nostr!",
  },
  sk,
);
// event.id and event.sig are computed and attached
```

**❌ Don't manually compute the ID from a JS object**

```typescript
// JSON.stringify object field order is not guaranteed across engines/versions
const badId = sha256(JSON.stringify({
  pubkey, created_at, kind, tags, content, // wrong — object, not array
}));
```

### Canonical Serialization

The event ID is the SHA-256 of:

```json
[0, "<pubkey>", <created_at>, <kind>, [<tags>], "<content>"]
```

Rules that must be followed exactly:
- **No spaces** between tokens
- Fields in **exactly this order**
- `pubkey` is lowercase hex
- `content` is a UTF-8 string (special chars escaped per JSON spec)

```typescript
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";

function computeEventId(event: UnsignedEvent): string {
  const serialized = JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content,
  ]);
  return bytesToHex(sha256(new TextEncoder().encode(serialized)));
}
```

### ⚠️ Gotchas

- **`created_at` is Unix seconds, not milliseconds.** `Date.now()` in JS returns milliseconds. Use `Math.floor(Date.now() / 1000)`.
- **Empty string content** is valid — `""` is not the same as omitting the field. The content field must always be present.
- **Field order in serialization is load-bearing.** `JSON.stringify` on an object does not guarantee order. Always build the array explicitly.

---

## 5. Signing Events

### Private Key Handling

**✅ Browser: use NIP-07 (window.nostr)**

```typescript
// The extension holds the private key — it never touches your app's memory
const signedEvent = await window.nostr.signEvent({
  kind: 1,
  created_at: Math.floor(Date.now() / 1000),
  tags: [],
  content: "Hello!",
});
// signedEvent includes id, pubkey, and sig set by the extension
// Do NOT call finalizeEvent after this
```

**✅ Server: use NIP-46 (nostr connect / remote signer)**

```typescript
import { NDKNip46Signer } from "@nostr-dev-kit/ndk";

const signer = new NDKNip46Signer(ndk, "bunker://<pubkey>?relay=<relay-url>");
await signer.blockUntilReady();
const signed = await signer.sign(unsignedEvent);
```

**❌ Don't embed private keys in client-side bundles**

```typescript
// This ends up in the browser bundle, DevTools, and any CDN cache
const PRIVATE_KEY = "nsec1abc..."; // catastrophic
```

**❌ Don't use weak randomness for key generation**

```typescript
// Math.random() is not cryptographically secure
const badKey = Array.from({ length: 32 }, () => Math.floor(Math.random() * 256));
```

**✅ Use OS-provided CSPRNG**

```typescript
import { generateSecretKey } from "nostr-tools";
const sk = generateSecretKey(); // uses crypto.getRandomValues internally
```

### Key Storage at Rest

Store private keys using [NIP-49](https://github.com/nostr-protocol/nips/blob/master/49.md) (password-encrypted key):

```typescript
import { nip49 } from "nostr-tools";

const encrypted = nip49.encrypt(secretKey, userPassword);
// Store `encrypted` (ncryptsec1...) — safe to persist
const recovered = nip49.decrypt(encrypted, userPassword);
```

### Validating Incoming Events

Always validate incoming events before processing:

```typescript
import { verifyEvent } from "nostr-tools";

function handleIncomingEvent(event: NostrEvent): boolean {
  if (!verifyEvent(event)) {
    console.warn("Dropped invalid event", event.id);
    return false;
  }
  return true;
}
```

**What `verifyEvent` checks:**
1. **Event ID**: must equal `SHA256(canonical_serialization)`
2. **Signature**: Schnorr signature over the event ID bytes using the author's pubkey (secp256k1)
3. **Pubkey**: must be a valid 32-byte compressed point (64 hex chars)

Also reject events with `created_at` more than 10 minutes in the future (clock skew protection).

**✅ Always verify before storing or forwarding**

```typescript
ws.onmessage = ({ data }) => {
  const [type, , event] = JSON.parse(data);
  if (type === "EVENT" && verifyEvent(event)) {
    store.insert(event);
  }
};
```

**❌ Don't trust events from a relay without verification**

```typescript
// A relay could inject arbitrary events — pubkey forgery, tampered content
ws.onmessage = ({ data }) => {
  const [, , event] = JSON.parse(data);
  store.insert(event); // dangerous
};
```

### ⚠️ Gotchas

- **NIP-07 `signEvent` returns the complete event object**, not just the signature. Don't call `finalizeEvent` afterward — it will recompute the ID and signature, potentially with a different `created_at`.
- **NIP-46 is async and requires a relay connection** to the bunker. Expect 200–500ms latency per signature — batch signing where possible.
- **`getPublicKey(sk)` returns compressed 32-byte x-only pubkey as hex**, not a 33-byte compressed point. Don't confuse these formats when interfacing with generic secp256k1 libraries.
- **Nostr keys are x-only 32-byte values**, not 33-byte compressed points.

---

## 6. Publishing Events

### Wire Format

```json
["EVENT", <event-object>]
```

The relay responds:

```json
["OK", "<event-id>", true, ""]
["OK", "<event-id>", false, "blocked: content policy violation"]
```

### Fan-out Publishing

Publish to all write relays in parallel and track per-relay confirmation:

```typescript
async function publishEvent(
  event: NostrEvent,
  writeRelays: string[],
): Promise<Map<string, "ok" | "failed" | "rejected">> {
  const results = new Map<string, "ok" | "failed" | "rejected">();

  await Promise.allSettled(
    writeRelays.map(async (url) => {
      try {
        const ws = await getOrOpenConnection(url);
        const status = await sendWithOkTimeout(ws, event, 5000);
        results.set(url, status);
      } catch {
        results.set(url, "failed");
      }
    }),
  );

  return results;
}
```

### Handling OK Responses

```typescript
function sendWithOkTimeout(
  ws: WebSocket,
  event: NostrEvent,
  timeoutMs: number,
): Promise<"ok" | "rejected" | "failed"> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("failed"), timeoutMs);

    const handler = (msg: MessageEvent) => {
      const [type, id, accepted, reason] = JSON.parse(msg.data);
      if (type === "OK" && id === event.id) {
        ws.removeEventListener("message", handler);
        clearTimeout(timer);
        resolve(accepted ? "ok" : "rejected");
      }
    };

    ws.addEventListener("message", handler);
    ws.send(JSON.stringify(["EVENT", event]));
  });
}
```

### Retry Logic

**✅ Retry transient failures with backoff, distinguish permanent failures**

```typescript
const PERMANENT_PREFIXES = ["duplicate:", "blocked:", "invalid:", "pow:", "restricted:"];

async function publishWithRetry(ws: WebSocket, event: NostrEvent, maxAttempts = 3) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const result = await sendWithOkTimeout(ws, event, 5000);
    if (result === "ok") return;
    if (result === "rejected") {
      // Don't retry permanent rejections
      throw new Error(`Relay rejected event: ${event.id}`);
    }
    // Transient failure — wait and retry
    await delay(1000 * 2 ** attempt + Math.random() * 500);
  }
}
```

Publishing the same event twice is idempotent — the second response is `["OK", id, true, "duplicate: ..."]` (still `ok=true`).

**❌ Don't retry on permanent rejection codes**

```typescript
// "duplicate:" means the relay already has this event — retrying is pointless
// "blocked:" means a policy decision — retrying won't change the outcome
while (true) {
  const r = await sendWithOkTimeout(ws, event, 5000);
  if (r === "ok") break;
  await delay(1000); // infinite retry of a blocked event
}
```

### ⚠️ Gotchas

- **Some relays close the WebSocket instead of sending `OK false`** when they reject an event. Treat an unexpected close during publish as a failure.
- **`OK true` does not guarantee the event is queryable.** A relay may accept an event for storage but apply different filters on read.
- **`auth-required:` means the relay needs NIP-42 authentication** before accepting events — not that your credentials are wrong. Authenticate and retry.
- **Event ID in the OK response must be checked** — some relays send a single OK for batched events; verify the ID matches before marking success.

---

## 7. Subscriptions

Subscriptions tell a relay which events to send you. They are opened with a `REQ` message and closed with a `CLOSE` message.

### Wire Format

```json
["REQ", "<subscription-id>", <filter1>, <filter2>, ...]
["CLOSE", "<subscription-id>"]
```

A filter can contain any combination of:

| Field | Type | Description |
|---|---|---|
| `ids` | `string[]` | Exact event IDs (hex) |
| `authors` | `string[]` | Pubkeys (hex) |
| `kinds` | `number[]` | Event kind integers |
| `since` | `number` | Unix timestamp lower bound (inclusive) |
| `until` | `number` | Unix timestamp upper bound (inclusive) |
| `limit` | `number` | Max events returned for the initial query |
| `#e` | `string[]` | Events whose `e` tags match |
| `#p` | `string[]` | Events whose `p` tags match |

### Subscription Limits

Most relays enforce limits via [NIP-11](https://github.com/nostr-protocol/nips/blob/master/11.md):

- `max_subscriptions`: typically 10–50 per connection
- `max_filters`: filter objects per single REQ (often 10)
- Safe practical cap: **≤20 concurrent subscriptions per relay**

Check these before opening subscriptions:

```typescript
const info = await fetch(relayUrl, {
  headers: { Accept: "application/nostr+json" },
}).then((r) => r.json());

const maxSubs = info.limitation?.max_subscriptions ?? 20;
const maxFilters = info.limitation?.max_filters ?? 10;
```

### Minimizing Subscriptions

**✅ Batch authors into one filter**

```typescript
// Fetching notes from 50 followed users — one subscription, one filter
const subId = "feed-" + Math.random().toString(36).slice(2, 8);
ws.send(JSON.stringify([
  "REQ", subId,
  {
    kinds: [1],
    authors: followedPubkeys,   // all 50 in a single array
    since: Math.floor(Date.now() / 1000) - 86400,
    limit: 200,
  },
]));
```

**❌ Don't open a subscription per user**

```typescript
// Opens 50 subscriptions — hits relay limits immediately
for (const pubkey of followedPubkeys) {
  ws.send(JSON.stringify(["REQ", pubkey.slice(0, 8), { kinds: [1], authors: [pubkey] }]));
}
```

**✅ Merge filters with the same window**

```typescript
// One REQ, two filter objects (notes + reactions)
ws.send(JSON.stringify([
  "REQ", "activity-xyz",
  { kinds: [1, 6], authors: [myPubkey], since: sinceTs },
  { kinds: [7], "#p": [myPubkey], since: sinceTs },
]));
```

**✅ Close one-shot queries immediately after EOSE**

```typescript
ws.onmessage = ({ data }) => {
  const msg = JSON.parse(data);
  if (msg[0] === "EOSE" && msg[1] === subId) {
    ws.send(JSON.stringify(["CLOSE", subId]));
    // process collected events
  }
};
```

**❌ Don't leave subscriptions open when you only need a snapshot**

```typescript
// Leaks a subscription slot until disconnect
ws.send(JSON.stringify(["REQ", "profile-once", { kinds: [0], authors: [pubkey], limit: 1 }]));
// ... never sends CLOSE
```

### EOSE (End of Stored Events) — State Machine Pattern

`["EOSE", "<sub-id>"]` signals that the relay has sent all stored events matching the filter. Events arriving after EOSE are newly published.

Use EOSE to separate "loading historical data" from "watching for live events":

```typescript
let historicalEvents: NostrEvent[] = [];
let isLive = false;

ws.onmessage = ({ data }) => {
  const [type, subIdOrEvent, event] = JSON.parse(data);
  if (type === "EVENT") {
    if (!isLive) {
      historicalEvents.push(event);
    } else {
      handleLiveEvent(event);
    }
  } else if (type === "EOSE") {
    isLive = true;
    renderTimeline(historicalEvents.sort((a, b) => b.created_at - a.created_at));
  }
};
```

### Subscription ID Generation

Use unique IDs per connection; reusing an ID silently replaces the old filter with no error.

```typescript
const subId = "feed-" + Math.random().toString(36).slice(2, 8);
// or
const subId = crypto.randomUUID().slice(0, 12);
```

### ⚠️ Gotchas

- **Reusing a subscription ID** replaces the existing subscription on most relays with no error — you'll silently stop receiving events from the old filter.
- **Large `authors` arrays**: some relays cap `max_filters` or enforce a maximum array length. Chunk arrays of pubkeys into batches of 100–256 and send multiple REQs if needed.
- **`limit` applies to stored events only** — it does not limit live events delivered after EOSE.
- **No `limit` means the relay decides** — on busy relays this can be thousands of events. Always include `limit` on historical queries.
- **Subscribing without constraints on busy relays** will receive tens of thousands of events per second. Always scope queries with `authors`, `since`, and `limit`.

---

## 8. Relay Discovery

### Bootstrap

Start with a hardcoded seed list. Never rely solely on user-provided relays:

```typescript
const SEED_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.nostr.band",
  "wss://relay.snort.social",
];
```

### NIP-65 Relay List (kind 10002)

The canonical source of a user's relay preferences. Always fetch this first:

```typescript
async function getUserRelays(pubkey: string): Promise<{ read: string[]; write: string[] }> {
  const event = await fetchLatest({ kinds: [10002], authors: [pubkey], limit: 1 });
  if (!event) return { read: SEED_RELAYS, write: SEED_RELAYS };

  const read: string[] = [];
  const write: string[] = [];

  for (const tag of event.tags) {
    if (tag[0] !== "r") continue;
    const url = normalizeRelayUrl(tag[1]);
    const marker = tag[2]; // "read", "write", or undefined (means both)
    if (!marker || marker === "read") read.push(url);
    if (!marker || marker === "write") write.push(url);
  }

  return { read, write };
}
```

Fallback chain: kind 10002 → kind 3 `content` field (legacy JSON) → hardcoded seed relays.

**✅ Respect read/write markers**

```typescript
// Publish only to write relays
await publishEvent(event, userRelays.write);

// Query only from read relays
const events = await queryRelays(filter, userRelays.read);
```

**❌ Don't treat all relays in kind 10002 as both read and write**

```typescript
// Ignores markers — may publish to read-only relays (they'll reject you)
const allRelays = event.tags.filter(t => t[0] === "r").map(t => t[1]);
await publishEvent(myEvent, allRelays);
```

### URL Normalization

```typescript
function normalizeRelayUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol.toLowerCase()}//${u.host.toLowerCase()}${u.pathname.replace(/\/$/, "") || ""}`;
  } catch {
    return url;
  }
}
// wss://relay.example.com/ and wss://relay.example.com map to same key
```

### Social Graph Crawling

Extract relay hints from events you encounter:

```typescript
function extractRelayHints(event: NostrEvent): string[] {
  const hints: string[] = [];
  for (const tag of event.tags) {
    if ((tag[0] === "e" || tag[0] === "p") && tag[2]) {
      hints.push(tag[2]);
    }
  }
  return hints.map(normalizeRelayUrl).filter(isValidRelayUrl);
}
```

### ⚠️ Gotchas

- **Bootstrapping a new user**: kind 10002 might not exist yet. Fall back to the `content` field of kind 3 (contact list), which historically stored relay preferences as JSON.
- **kind 10002 events may only be on the user's own relays.** If you can't find them on your seed list, query the relay hints from kind 3 tags first.
- **Relay URL deduplication requires normalization.** `wss://relay.example.com/` and `wss://relay.example.com` are the same relay but treated as two entries without normalization.
- **NIP-05 `relays` field** in `/.well-known/nostr.json` can supplement relay discovery but is often stale or missing — treat it as a hint, not authoritative.

---

## 9. Relay Metrics & Purging

### What to Measure

```typescript
interface RelayMetrics {
  url: string;
  connectLatencyMs: number[];     // time from WS open to first message
  eoseLatencyMs: number[];        // time from REQ to EOSE (rolling window of 20)
  timeToFirstEventMs: number[];   // time from REQ to first EVENT
  reconnectCount: number;
  uptimeRatio: number;            // fraction of time connected in the last hour
  deliveryRate: number;           // events received / events expected (via known filters)
  lastSeen: number;               // Unix timestamp
}
```

### Measuring Latency

**Connect latency** — browsers block raw WebSocket ping/pong frames, use a `limit: 0` probe REQ instead:

```typescript
async function measureConnectLatency(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const ws = new WebSocket(url);
    ws.onopen = () => {
      ws.send(JSON.stringify(["REQ", "ping-probe", { kinds: [1], limit: 0 }]));
    };
    ws.onmessage = () => {
      ws.send(JSON.stringify(["CLOSE", "ping-probe"]));
      ws.close();
      resolve(Date.now() - start);
    };
    ws.onerror = () => reject(new Error("connect failed"));
    setTimeout(() => { ws.close(); reject(new Error("timeout")); }, 5000);
  });
}
```

**EOSE latency** (measure on real subscriptions):

```typescript
function trackSubscriptionLatency(ws: WebSocket, subId: string, onEose: (ms: number) => void) {
  const start = Date.now();
  const handler = ({ data }: MessageEvent) => {
    const [type, id] = JSON.parse(data);
    if (type === "EOSE" && id === subId) {
      ws.removeEventListener("message", handler);
      onEose(Date.now() - start);
    }
  };
  ws.addEventListener("message", handler);
}
```

### Scoring Formula

```typescript
function scoreRelay(metrics: RelayMetrics): number {
  const recentEose = metrics.eoseLatencyMs.slice(-20);
  const avgEose = recentEose.reduce((a, b) => a + b, 0) / (recentEose.length || 1);
  const latencyScore = Math.max(0, 1 - avgEose / 5000); // 0 at 5s, 1 at 0ms

  return (
    latencyScore * 0.3 +
    metrics.uptimeRatio * 0.4 +
    metrics.deliveryRate * 0.3
  );
}
```

### Purge Thresholds

```typescript
function shouldPurgeRelay(metrics: RelayMetrics): boolean {
  const recentEose = metrics.eoseLatencyMs.slice(-10);
  const avgEose = recentEose.reduce((a, b) => a + b, 0) / (recentEose.length || 1);

  return (
    avgEose > 5000 ||               // consistently slow
    metrics.uptimeRatio < 0.5 ||    // disconnecting more than half the time
    metrics.deliveryRate < 0.5 ||   // returning fewer events than expected
    metrics.reconnectCount >= 3     // 3+ failures in the current session
  );
}
```

**✅ Always keep a minimum healthy pool**

```typescript
const MIN_RELAYS = 3;

function pruneRelayPool(relays: RelayMetrics[]): RelayMetrics[] {
  const sorted = relays.sort((a, b) => scoreRelay(b) - scoreRelay(a));
  const healthy = sorted.filter(r => !shouldPurgeRelay(r));
  // Never drop below minimum — a slow relay beats no relay
  return healthy.length >= MIN_RELAYS ? healthy : sorted.slice(0, MIN_RELAYS);
}
```

**❌ Don't purge on a single failure**

```typescript
// Transient network blips are common — one bad measurement isn't a trend
if (latency > 2000) removeRelay(url);
```

### ⚠️ Gotchas

- **Browsers cannot send WebSocket ping frames.** Measure latency via a REQ round-trip instead.
- **A relay returning EOSE immediately with zero events is healthy, not broken.** Distinguish "relay responded fast" from "relay never responds."
- **EOSE latency varies by filter complexity.** A filter with a large `since` window queries more data. Compare latencies across equivalent filters.
- **Delivery rate is hard to measure perfectly.** Proxy it by subscribing to events you've already seen on other relays and checking if they appear here within a time window.

---

## 10. Connection Management

### WebSocket Lifecycle

```
open → [NIP-42 auth if challenged] → send REQs → receive events/EOSE → send CLOSEs → close
```

### Connection Class with Auto-Reconnect

```typescript
class RelayConnection {
  private ws: WebSocket | null = null;
  private subs = new Map<string, Filter[]>();
  private reconnectAttempt = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  async connect(url: string) {
    this.ws = new WebSocket(url);
    this.ws.onopen = () => {
      this.reconnectAttempt = 0;
      // Re-send all active subscriptions after (re)connect
      for (const [id, filters] of this.subs) {
        this.ws!.send(JSON.stringify(["REQ", id, ...filters]));
      }
    };
    this.ws.onclose = () => this.scheduleReconnect(url);
    this.ws.onmessage = (e) => this.handleMessage(e);
  }

  private scheduleReconnect(url: string) {
    const jitter = Math.random() * 500; // prevents thundering herd
    const delay = Math.min(1000 * 2 ** this.reconnectAttempt, 60_000) + jitter;
    this.reconnectAttempt++;
    setTimeout(() => this.connect(url), delay);
  }

  unsubscribe(subId: string) {
    this.subs.delete(subId);
    this.ws?.send(JSON.stringify(["CLOSE", subId]));
    this.resetIdleTimer();
  }

  private resetIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.subs.size === 0) {
      this.idleTimer = setTimeout(() => this.disconnect(), 30_000);
    }
  }
}
```

### Connection Pooling — One WebSocket Per Relay

**✅ Share one WebSocket per relay URL**

```typescript
const pool = new Map<string, RelayConnection>();

function getConnection(url: string): RelayConnection {
  const normalized = normalizeRelayUrl(url);
  if (!pool.has(normalized)) {
    const conn = new RelayConnection();
    conn.connect(normalized);
    pool.set(normalized, conn);
  }
  return pool.get(normalized)!;
}
```

**❌ Don't open a new connection per subscription or feature**

```typescript
// Two different parts of your app both open a WebSocket to the same relay
// — wastes connections and doubles your subscription count
const wsForFeed = new WebSocket("wss://relay.example.com");
const wsForProfile = new WebSocket("wss://relay.example.com");
```

### NIP-42 Authentication

Some relays require authentication before serving restricted content or accepting events. Challenges can arrive at any time, not only on connect.

```typescript
function handleMessage(event: MessageEvent) {
  const msg = JSON.parse(event.data);

  if (msg[0] === "AUTH") {
    respondToAuthChallenge(msg[1]);
  }
}

async function respondToAuthChallenge(challenge: string, url: string, sk: Uint8Array) {
  const authEvent = finalizeEvent(
    {
      kind: 22242,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["relay", url],
        ["challenge", challenge],
      ],
      content: "",
    },
    sk,
  );
  ws.send(JSON.stringify(["AUTH", authEvent]));
}
```

### Graceful Shutdown

```typescript
async function shutdown(connections: RelayConnection[]) {
  await Promise.all(
    connections.map(async (conn) => {
      await conn.closeAllSubscriptions(); // sends CLOSE for each active sub
      conn.disconnect();
    }),
  );
}
```

### ⚠️ Gotchas

- **Subscriptions do not persist across reconnects.** When the WebSocket reconnects, you must resend every active `REQ`. Keep a local registry of active subscriptions and replay them on `onopen`.
- **AUTH challenges can arrive at any time**, not just on connection open. Your message handler must handle `["AUTH", ...]` at any point.
- **Don't reconnect on intentional close.** If your code calls `ws.close()`, the `onclose` event fires — distinguish user-initiated closes from unexpected ones to avoid reconnect loops.
- **Exponential backoff without jitter causes thundering herd.** If many clients disconnect simultaneously (relay restart), they'll all reconnect at the same intervals. Add `Math.random() * 500` jitter.

---

## 11. General Best Practices & Gotchas

### Event Deduplication

Events arrive from multiple relays. Deduplicate by ID with a bounded LRU set:

```typescript
class LruSet<T> {
  private map = new Map<T, null>();
  constructor(private maxSize: number) {}

  has(value: T): boolean { return this.map.has(value); }

  add(value: T) {
    if (this.map.size >= this.maxSize) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
    this.map.set(value, null);
  }
}

const seenIds = new LruSet<string>(10_000);

function handleEvent(event: NostrEvent) {
  if (seenIds.has(event.id)) return;
  seenIds.add(event.id);
  process(event);
}
```

### NIP-11 Relay Info

Fetch relay capabilities on first connect to avoid hitting undocumented limits:

```typescript
interface RelayInfo {
  name?: string;
  description?: string;
  limitation?: {
    max_message_length?: number;
    max_subscriptions?: number;
    max_filters?: number;
    max_limit?: number;
    min_pow_difficulty?: number;
    auth_required?: boolean;
    payment_required?: boolean;
  };
}

async function fetchRelayInfo(url: string): Promise<RelayInfo> {
  const httpUrl = url.replace(/^wss?:\/\//, "https://");
  return fetch(httpUrl, {
    headers: { Accept: "application/nostr+json" },
  }).then((r) => r.json());
}
```

### Sort by `created_at`, Not Arrival Order

```typescript
// Relays return stored events in arbitrary order
const events = await queryAll(filter, relays);
events.sort((a, b) => b.created_at - a.created_at); // newest first
```

### Handling NOTICE Messages

`["NOTICE", "<message>"]` messages are relay-specific informational strings. Log them but don't treat them as protocol errors:

```typescript
if (msg[0] === "NOTICE") {
  console.debug(`[${relayUrl}] NOTICE: ${msg[1]}`);
  // Do not throw, disconnect, or alter subscription state
}
```

### Anti-pattern Summary

| Anti-pattern | Consequence | Fix |
|---|---|---|
| `Date.now()` for `created_at` | Milliseconds instead of seconds — ID mismatch, replaceable events silently discarded | `Math.floor(Date.now() / 1000)` |
| Spaces in canonical JSON | Wrong event ID, invalid signature | Use array literal `[0, pubkey, ...]`, not object |
| Multiple WebSockets to same relay | Exhausts connection limits, doubles subscription count | Shared WS per relay URL via pool |
| One subscription per followed user | Hits relay subscription caps immediately | Batch all authors into one filter |
| Never calling CLOSE | Exhausts relay subscription slots, gets rate-limited | CLOSE after EOSE for one-shot queries |
| Reusing subscription IDs | Silently replaces old filter with no error | `crypto.randomUUID().slice(0, 12)` |
| `Math.random()` for key generation | Not cryptographically secure | `generateSecretKey()` (uses `crypto.getRandomValues`) |
| No jitter in reconnect backoff | Thundering herd on relay restart | Add `Math.random() * 500` ms jitter |
| Retrying permanent rejections | Infinite loop, possible IP ban | Check `blocked:` / `invalid:` prefix, don't retry |
| Sorting by arrival order | Events from multiple relays arrive out of order | Sort by `created_at` descending |
| No deduplication across relays | Duplicate processing, UI glitches | LRU set of seen event IDs |
| Purging after a single failure | Unnecessary relay churn | Require 3+ failures before purging |
| Ignoring NIP-11 limits | Unexpected disconnects / silent sub drops | Fetch and cache relay info on first connect |
| Querying without `limit` | Relay returns thousands of events | Always include `limit` on historical queries |
| Not re-sending REQs on reconnect | Silent subscription loss after reconnect | Replay all active subs in `onopen` |
| Embedding private keys in bundles | Key exposed in DevTools, CDN cache, bundles | Use NIP-07 (browser) or NIP-46 (server) |

---

## References

- [NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md) — Basic protocol (events, subscriptions, wire format)
- [NIP-05](https://github.com/nostr-protocol/nips/blob/master/05.md) — DNS-based internet identifiers
- [NIP-07](https://github.com/nostr-protocol/nips/blob/master/07.md) — Browser extension signing API
- [NIP-11](https://github.com/nostr-protocol/nips/blob/master/11.md) — Relay information document
- [NIP-42](https://github.com/nostr-protocol/nips/blob/master/42.md) — Authentication of clients to relays
- [NIP-46](https://github.com/nostr-protocol/nips/blob/master/46.md) — Nostr connect (remote signing)
- [NIP-49](https://github.com/nostr-protocol/nips/blob/master/49.md) — Private key encryption
- [NIP-65](https://github.com/nostr-protocol/nips/blob/master/65.md) — Relay list metadata
- [nostr-tools](https://github.com/nbd-wtf/nostr-tools) — Reference TypeScript/JS library
- [@noble/secp256k1](https://github.com/paulmillr/noble-secp256k1) — Low-level cryptography
- [go-nostr](https://github.com/nbd-wtf/go-nostr) — Reference Go library

---

## 12. Go / go-nostr — Event Patterns

### Key Material: Accept Both nsec and Hex

Users may supply private keys as `nsec1…` (bech32) or raw hex. Accept both and normalise early:

```go
import "github.com/nbd-wtf/go-nostr/nip19"

func decodeSecretKey(raw string) (skHex string, err error) {
    if strings.HasPrefix(raw, "nsec") {
        prefix, data, err := nip19.Decode(raw)
        if err != nil || prefix != "nsec" {
            return "", fmt.Errorf("invalid nsec: %w", err)
        }
        return data.(string), nil
    }
    // assume hex
    return raw, nil
}
```

`nip19.Decode` returns `(prefix string, data any, err error)`. For `nsec` the data is a hex string; for `npub` it is also hex; for `note1` it is a hex event ID.

### Creating and Signing Events

```go
import "github.com/nbd-wtf/go-nostr"

event := nostr.Event{
    PubKey:    pubkeyHex,
    CreatedAt: nostr.Now(),   // nostr.Timestamp — Unix seconds
    Kind:      1,
    Tags:      nostr.Tags{{"t", "nostr"}},
    Content:   "Hello!",
}

if err := event.Sign(skHex); err != nil {
    return err
}
// event.ID and event.Sig are now set
```

`event.Sign` computes the canonical serialization, SHA-256 hashes it to produce `ID`, then signs with secp256k1 Schnorr. Never set `ID` or `Sig` manually.

### Kind 30078 — Sync Progress Events

This codebase uses kind 30078 (parameterized replaceable) to track event-forwarder sync windows. The `d` tag is the source relay URL; `from`/`to` carry the window boundaries as Unix-second strings.

```go
// event-forwarder/pkg/nsync/nsync.go
event := nostr.Event{
    PubKey:    keyPair.PublicKeyHex,
    CreatedAt: nostr.Now(),
    Kind:      30078,
    Tags: nostr.Tags{
        {"d", sourceRelayURL},
        {"from", strconv.FormatInt(window.From.Unix(), 10)},
        {"to",   strconv.FormatInt(window.To.Unix(), 10)},
    },
    Content: "",
}
_ = event.Sign(keyPair.PrivateKeyHex)
```

To read back the latest window:

```go
filter := nostr.Filter{
    Kinds:  []int{30078},
    Authors: []string{pubkeyHex},
    Tags:   nostr.TagMap{"d": []string{sourceRelayURL}},
    Limit:  1,
}
```

### Always Validate Incoming Events

```go
// web-of-trust/pkg/crawler/crawler.go
if ok, err := event.CheckSignature(); !ok || err != nil {
    log.Warnf("dropped invalid event %s: %v", event.ID, err)
    continue
}
```

`CheckSignature` returns `(bool, error)` — check both. A false result with a nil error means the math checked out but the ID didn't match.

### Extracting Tag Values

```go
// kind 3 follow-list parsing
for _, tag := range event.Tags {
    if len(tag) >= 2 && tag[0] == "p" {
        followedPubkey := tag[1]
        // optional relay hint at tag[2]
    }
}

// kind 10002 relay-list parsing
for _, tag := range event.Tags {
    if len(tag) >= 2 && tag[0] == "r" {
        relayURL := tag[1]
        marker := ""
        if len(tag) >= 3 {
            marker = tag[2] // "read", "write", or ""
        }
        _ = marker
    }
}
```

Use `nostr.Tags.GetFirst([]string{"d"})` or iterate manually — both patterns appear in the codebase.

---

## 13. Go / go-nostr — Relay & Connection Management

### Opening a Connection

```go
ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
defer cancel()

relay, err := nostr.RelayConnect(ctx, "wss://relay.example.com")
if err != nil {
    return fmt.Errorf("connect: %w", err)
}
defer relay.Close()
```

`RelayConnect` dials the WebSocket, waits for the connection to be established, and returns a `*nostr.Relay`. The context controls the dial timeout only; subsequent operations use their own contexts.

### Subscription Lifecycle

```go
sub, err := relay.Subscribe(ctx, []nostr.Filter{filter})
if err != nil {
    return err
}
defer sub.Unsub()

for {
    select {
    case event, ok := <-sub.Events:
        if !ok {
            return // channel closed — relay disconnected
        }
        process(event)
    case <-sub.EndOfStoredEvents:
        // EOSE received — switch to live mode or return
        return
    case <-ctx.Done():
        return ctx.Err()
    }
}
```

Always `defer sub.Unsub()` to send `CLOSE` and release the slot on the relay.

### Reconnect with Exponential Backoff

go-nostr does not reconnect automatically. Track state and schedule retries yourself:

```go
// web-of-trust/pkg/crawler/crawler.go
type relayState struct {
    url      string
    conn     *nostr.Relay
    alive    bool
    backoff  time.Duration   // starts at 30s, doubles each failure, capped at 5m
    retryAt  time.Time
    failures atomic.Int32
}

func (s *relayState) scheduleReconnect() {
    s.alive = false
    s.conn = nil
    s.failures.Add(1)
    if s.backoff == 0 {
        s.backoff = 30 * time.Second
    } else {
        s.backoff = min(s.backoff*2, 5*time.Minute)
    }
    s.retryAt = time.Now().Add(s.backoff)
}
```

After 5 consecutive failures, remove the relay from the active pool — don't keep retrying a dead endpoint forever.

### Publishing with Timeout

```go
ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
defer cancel()

if err := relay.Publish(ctx, event); err != nil {
    // relay.Close() — connection may be broken; reset it
    return fmt.Errorf("publish %s: %w", event.ID, err)
}
```

`relay.Publish` waits for the relay's `OK` message. If the relay closes the connection instead of sending `OK false`, the call returns an error — treat that as a transient failure and reconnect.

### Normalising Relay URLs

```go
import "github.com/nbd-wtf/go-nostr"

normalized := nostr.NormalizeURL(rawURL)
// "wss://Relay.Example.com/" → "wss://relay.example.com"
```

Use `NormalizeURL` before using a relay URL as a map key, config value, or `d` tag.

### NIP-11 Relay Info

```go
import "github.com/nbd-wtf/go-nostr/nip11"

ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
defer cancel()

info, err := nip11.Fetch(ctx, relayURL)
if err != nil {
    // relay is unreachable or doesn't support NIP-11 — treat as unknown limits
}
_ = info.Limitation.MaxSubscriptions
_ = info.Limitation.MaxFilters
```

Fetch NIP-11 on first connect and cache the result. Use it to bound subscription count and filter array sizes before hitting undocumented relay limits.

---

## 14. StrFry Plugin Protocol (stdin/stdout JSON)

StrFry calls a plugin binary for every incoming event via a simple line-delimited JSON protocol over stdin/stdout. The plugin decides whether to accept, reject, or shadow-reject the event.

### Message Types

**Input (from StrFry → plugin):**

```go
// whitelist-plugin/pkg/handler/messages.go
type InputMsg struct {
    Type       string     `json:"type"`        // always "new"
    Event      Event      `json:"event"`       // {id, pubkey, kind, ...}
    ReceivedAt int64      `json:"receivedAt"`  // Unix timestamp (seconds)
    SourceType SourceType `json:"sourceType"`  // "IP4", "IP6", "Import", "Stream", "Sync", "Stored"
    SourceInfo string     `json:"sourceInfo"`  // IP address or source detail
}
```

**Output (plugin → StrFry):**

```go
type OutputMsg struct {
    Id     string `json:"id"`     // must echo the event ID from input
    Action Action `json:"action"` // "accept", "reject", or "shadowReject"
    Msg    string `json:"msg"`    // NIP-20 reason string, shown to client on reject
}
```

**Actions:**
- `accept` — write the event to StrFry's LMDB
- `reject` — refuse the event and return `Msg` to the publishing client
- `shadowReject` — silently discard; the client sees success but the event is dropped

### Wire Format

One JSON object per line, no pretty-printing. The plugin reads lines from stdin and writes lines to stdout:

```go
// Serialize output
func SerializeOutputMsg(msg OutputMsg) ([]byte, error) {
    b, err := json.Marshal(msg)
    if err != nil {
        return nil, err
    }
    return append(b, '\n'), nil
}

// Deserialize input
func DeserializeInputMsg(line []byte) (*InputMsg, error) {
    var msg InputMsg
    return &msg, json.Unmarshal(line, &msg)
}
```

### Plugin Event Loop

```go
// cmd/whitelist/main.go pattern
scanner := bufio.NewScanner(os.Stdin)
scanner.Buffer(make([]byte, 10*1024*1024), 10*1024*1024) // 10MB line buffer

for scanner.Scan() {
    line := scanner.Bytes()
    input, err := handler.DeserializeInputMsg(line)
    if err != nil {
        continue // skip malformed lines
    }

    output := handler.Handle(input)

    b, _ := handler.SerializeOutputMsg(output)
    os.Stdout.Write(b)
}
```

Set `scanner.Buffer` to at least 1MB — large events (profile metadata, long-form articles) can exceed the default 64KB scanner buffer and cause silent drops.

### Fail-Closed on Whitelist Errors

If the whitelist server is unreachable, reject the event rather than accepting it. Accepting an unknown pubkey when the trust check fails defeats the purpose of the filter:

```go
// whitelist-plugin/pkg/handler/router_handler.go
whitelisted, err := h.client.IsWhitelisted(ctx, event.PubKey)
if err != nil {
    return OutputMsg{Id: input.Event.ID, Action: ActionReject, Msg: "error: whitelist check failed"}
}
```

### Preserving the Raw Event for Quarantine

The whitelist plugin's router variant keeps the raw `json.RawMessage` from input so it can forward the verbatim event to the quarantine relay without re-encoding:

```go
type RouterInputMsg struct {
    Type       string          `json:"type"`
    Event      json.RawMessage `json:"event"` // raw bytes — no round-trip re-encoding
    ReceivedAt int64           `json:"receivedAt"`
    SourceType SourceType      `json:"sourceType"`
    SourceInfo string          `json:"sourceInfo"`
}
```

This matters because re-encoding could subtly change whitespace or field order, producing a different event ID.

### SourceType Values

| Value | Meaning |
|---|---|
| `IP4` / `IP6` | Direct connection from a remote client |
| `Import` | Loaded via `strfry import` |
| `Stream` | Relayed from another relay via `strfry stream` |
| `Sync` | Fetched via `strfry sync` |
| `Stored` | Internal re-check of an already-stored event |

Use `SourceType` to skip expensive trust checks for trusted internal sources (`Import`, `Stored`).

---

## 15. Quarantine Pattern

Non-whitelisted events that pass basic heuristics are diverted to a quarantine relay instead of being dropped. When a pubkey is later whitelisted, the quarantine-rescuer replays their events into the main relay.

### Heuristics Gate

Before quarantining, apply a cheap filter to avoid filling the quarantine relay with spam:

```go
// whitelist-plugin/pkg/heuristics/heuristics.go
func Allow(event Event) (bool, string) {
    if event.ID == "" || event.PubKey == "" {
        return false, "missing id or pubkey"
    }
    if !isAllowedKind(event.Kind) {
        return false, fmt.Sprintf("kind %d not quarantined", event.Kind)
    }
    if len(event.Content) > 256*1024 {
        return false, "content too large"
    }
    return true, ""
}

// Only quarantine these kinds — everything else is dropped outright
var allowedKinds = map[int]bool{
    0: true, // profile metadata
    1: true, // text note
    3: true, // follow list
}
```

### Non-Blocking Enqueue

The plugin's hot path (handling StrFry's stdin) must not block. The quarantine publisher owns a background goroutine and a buffered channel:

```go
// whitelist-plugin/pkg/quarantine/publisher.go
func (p *Publisher) Enqueue(evt json.RawMessage) {
    select {
    case p.queue <- evt:
        p.enqueued.Add(1)
    default:
        p.dropped.Add(1) // channel full — drop rather than block the plugin
    }
}
```

The background worker drains the channel sequentially, maintaining a single persistent relay connection with reconnect-on-error.

### Quarantine Publisher Reconnect Loop

```go
func (p *Publisher) run() {
    var relay *nostr.Relay
    backoff := 500 * time.Millisecond

    for evt := range p.queue {
        if relay == nil {
            var err error
            relay, err = nostr.RelayConnect(context.Background(), p.relayURL)
            if err != nil {
                time.Sleep(backoff)
                backoff = min(backoff*2, 30*time.Second)
                // re-queue or drop evt
                continue
            }
            backoff = 500 * time.Millisecond
        }

        ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
        err := relay.Publish(ctx, evt)
        cancel()
        if err != nil {
            relay.Close()
            relay = nil // reconnect next iteration
            p.publishErrors.Add(1)
        } else {
            p.published.Add(1)
        }
    }
}
```

### Rescuer: Publish in Created-At Order

When replaying quarantined events to the main relay, **publish each pubkey's events in ascending `created_at` order**. Relays use last-write-wins for replaceable kinds (0, 3); if a stale version arrives after the fresh one it silently clobbers it.

```go
// quarantine-rescuer/internal/forwarder/forwarder.go
sort.Slice(events, func(i, j int) bool {
    return events[i].CreatedAt < events[j].CreatedAt // oldest first
})

for _, evt := range events {
    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    _ = relay.Publish(ctx, evt)
    cancel()
}
```

**Do not parallelise publishes within a single pubkey.** Use a worker pool to parallelise across pubkeys, but keep each pubkey's events sequential within one worker.

---

## 16. Go-Specific Gotchas

### `nostr.Timestamp` Is Seconds, Not Milliseconds

`nostr.Timestamp` is `int64` (Unix seconds). `nostr.Now()` returns the current time in seconds. Never pass `time.Now().UnixMilli()` or `time.Now().UnixNano()` to a `Timestamp` field.

```go
filter := nostr.Filter{
    Since: func() *nostr.Timestamp { t := nostr.Timestamp(time.Now().Add(-24 * time.Hour).Unix()); return &t }(),
}
```

`Since` and `Until` are `*nostr.Timestamp` (pointer) — use a local variable and take its address; you cannot take the address of a `nostr.Timestamp(...)` expression directly.

### go-nostr Does Not Reconnect Automatically

Unlike NDK, `nostr.RelayConnect` gives you a single WebSocket connection with no reconnect logic. You must track failures and re-dial manually. Keep a reconnect counter per relay; after 5 consecutive failures, remove the relay from your pool rather than retrying indefinitely.

### Subscribe Error Messages Include the Full Filter Dump

`relay.Subscribe` wraps errors with the filter marshalled to JSON: `"couldn't subscribe to [{kinds:[1],...}]: failed to write"`. This is noisy in logs. Strip the prefix:

```go
// web-of-trust/pkg/crawler/crawler.go
func cleanSubscribeError(err error) string {
    msg := err.Error()
    // Remove "couldn't subscribe to [{...}]: " prefix
    if idx := strings.Index(msg, "]: "); idx != -1 {
        return msg[idx+3:]
    }
    return msg
}
```

### Replaceable Events Must Arrive Oldest-First

Relays silently discard replaceable events whose `created_at` is older than what they have stored. During replay (quarantine rescuer, import), always sort by `created_at` ascending and publish sequentially per pubkey. Publishing in parallel or out of order can result in the stale version winning.

### Kind 3 Follow Lists Can Be Enormous

Kind 3 events from active users can have 10,000+ `p` tags. Dgraph mutations for that many edges are expensive. Chunk follow insertions:

```go
const chunkSize = 10_000

for i := 0; i < len(follows); i += chunkSize {
    end := min(i+chunkSize, len(follows))
    if err := db.insertFollows(pubkey, follows[i:end]); err != nil {
        return err
    }
}
```

Always check `event.CheckSignature()` before processing kind 3 — a relay could serve a tampered follow list that inflates a pubkey's trust score.

### Scanner Buffer Must Be Enlarged for StrFry Plugin

The default `bufio.Scanner` buffer is 64KB. StrFry events can be larger (profile metadata with long bios, follow lists with thousands of tags). Set a 10MB buffer to avoid silent truncation:

```go
scanner := bufio.NewScanner(os.Stdin)
scanner.Buffer(make([]byte, 10*1024*1024), 10*1024*1024)
```

A truncated line fails `json.Unmarshal` and the plugin responds with nothing — StrFry treats silence as accept on some versions, which defeats the whitelist.

### `relay.Publish` Returns Error on Connection Close

Some relays close the WebSocket on reject instead of sending `OK false`. `relay.Publish` returns an error in this case — the call site cannot distinguish "relay is dead" from "relay rejected the event via connection close". Treat any publish error as a transient failure: close the relay, reconnect, and retry once. Don't retry indefinitely.

### NIP-42 Is Not Implemented — Use Trusted Relay Topology

This codebase does not implement NIP-42 client authentication. All relays are either locally managed (StrFry on localhost) or well-known public relays that don't require auth. If you add a relay that requires NIP-42, the connection will appear to succeed but subscriptions will return no events and publishes will be rejected. Watch for this in logs.

### Panic on Infrastructure Failure Is Intentional

The event-forwarder's connection manager calls `log.Panicf` after 3 failed connection attempts:

```go
// event-forwarder: connection.go
if attempt >= 3 {
    log.Panicf("failed to connect to %s after %d attempts", url, attempt)
}
```

This is a deliberate fail-fast design — the forwarder runs under a process supervisor (Docker restart policy). A panic triggers a restart with a clean state rather than limping along with a broken connection. Do not change this to a soft error without adding equivalent recovery logic.

### Anti-Pattern Summary (Go)

| Anti-pattern | Consequence | Fix |
|---|---|---|
| `time.Now().UnixMilli()` for `nostr.Timestamp` | Timestamp 1000× too large — events silently discarded as far future | `nostr.Now()` or `nostr.Timestamp(time.Now().Unix())` |
| Taking address of `nostr.Timestamp(...)` expression | Compile error — cannot address a conversion | Assign to a variable first, then `&variable` |
| Relying on go-nostr to reconnect | Silent data loss after any network blip | Implement your own reconnect loop with backoff |
| Publishing replaceable events in parallel | Stale version wins, corrupts relay state | Sort by `created_at` asc, publish one-at-a-time per pubkey |
| Default 64KB scanner buffer in plugin | Silent truncation of large events → missed filter decisions | `scanner.Buffer(make([]byte, 10<<20), 10<<20)` |
| Accepting on whitelist check error | Bypasses trust filter entirely | Fail-closed: reject on error |
| Blocking the plugin's hot path in Enqueue | StrFry times out waiting for plugin response | Use buffered channel + `select { default: drop }` |
| Processing kind 3 without signature check | Tampered follow list inflates trust scores | Always call `event.CheckSignature()` before storing |
