# Paid unlock — "paid private file"

Pay to reveal a sealed secret. A seller seals a small **secret** — a file
decryption key + locator, a licence key, a download link, an access code —
behind a price; a buyer pays **non-custodially** and pulls it. The
winbit32-native answer to ZEC-paid digital-goods storefronts, built entirely
on rails the gateway already runs.

> **Status:** opt-in (`PAID_UNLOCK_ENABLED=1`). Off by default so an embedding
> host (e.g. Seneschal) doesn't gain a secret-storing write surface unasked.

## Trust model (read this)

- **Payment is non-custodial.** Native ZEC/XMR goes straight to the receiving
  wallet; we only ever hold a **view key** to *detect* it (the same engine the
  rest of the gateway sells). USDC settles peer-to-merchant over x402. We never
  hold a spend key.
- **The file plaintext never touches us.** The seller encrypts the file in the
  browser (WebCrypto AES-256-GCM) and hosts only the ciphertext. The sealed
  "secret" is just the key + IV + locator.
- **The secret is sealed at rest** with the gateway master key
  (`PRIVATE_WATCH_ENCRYPTION_KEY`, AES-256-GCM — the same primitive used for
  view keys). The running process opens it in-memory only to deliver on a
  confirmed payment, so we are **not blind** to the secret at release time.
  Platform-blind delivery (key + file browser-to-browser over the **Nym
  mixnet**) is the planned **phase-2** — it is *not* claimed today.

This is deliberately honest: V1 buys you a non-custodial *payment* rail and
keeps the file itself off our servers; full end-to-end blindness is the next
milestone.

## How it works

```
seller                         gateway                         buyer
  │  encrypt file in browser      │                               │
  │  host ciphertext (.enc)       │                               │
  │  POST /v1/unlock/listing  ───►│ seal secret at rest           │
  │      {title,price,secret}     │ → listing id + ownerToken     │
  │                               │                               │
  │                               │◄── POST .../{id}/order {chain}│  (or /buy via x402)
  │                               │ quote: payTo + amount + memo  │
  │                               │ + claimToken ───────────────► │
  │                               │                               │  pays ZEC/XMR to seller
  │                               │ receive-poller sees the coin  │
  │                               │ (view key) → order = paid     │
  │                               │◄── POST .../order/{id}/claim   │
  │                               │ open secret → return ───────► │  decrypt locally
```

## API surface

All under the standalone gateway REST host (winbit32). Native orders + claims
are **free HTTP** (you pay in coin, not in API calls); the USDC buy is x402.

| Method & path | Auth | Purpose |
| --- | --- | --- |
| `POST /v1/unlock/listing` | none (rate-limited) | Seal a secret behind a price. Returns `{ id, ownerToken, … }`. |
| `GET /v1/unlock/listings` | none | Public **shop feed** — opt-in (`visibility:"public"`) listings, newest first. **Never** the secret. `?limit&offset`. |
| `GET /v1/unlock/listing/:id` | none | Public listing (title, price, rails). **Never** the secret. |
| `DELETE /v1/unlock/listing/:id` | `x-unlock-token` | Withdraw a listing. |
| `POST /v1/unlock/listing/:id/order` | none | Native ZEC/XMR pay quote. Body `{ chain }`. Returns the quote + a `claimToken`. |
| `POST /v1/unlock/listing/:id/buy` | x402 (USDC) | Instant buy at the listing price; the secret is in the 200. |
| `GET /v1/unlock/order/:orderId` | `x-claim-token` | Order status (`pending`/`paid`/`claimed`/`expired`). |
| `POST /v1/unlock/order/:orderId/claim` | `x-claim-token` | Reveal the secret once paid (up to the per-order claim limit). |

### Listing body

```json
{
  "title": "Audit report (PDF)",
  "description": "optional",
  "secret": "{\"v\":1,\"alg\":\"A256GCM\",\"k\":\"…\",\"iv\":\"…\",\"name\":\"report.pdf\",\"url\":\"https://host/report.pdf.enc\"}",
  "priceUsdCents": 500,
  "payChains": ["zcash"],
  "claimMax": 3,
  "maxOrders": null,
  "expiresInSec": 2592000,
  "visibility": "unlisted"
}
```

`secret` is opaque to the gateway — any string ≤ 8 KiB. The browser demo packs
a JWK + IV + locator; you could equally store a licence key or a private URL.

`visibility` is `unlisted` (default — link-only; share the id) or `public`
(advertised in the shop feed at `GET /v1/unlock/listings`). Either way the feed
never returns the secret; discovery only controls whether a listing is *listed*.

## MCP tools

Opt-in alongside the REST routes (`<prefix>_paid_unlock_*`):

- `…_paid_unlock_info` — rails, price band, endpoints, trust model, counters (free).
- `…_paid_unlock_listing` — public listing lookup by id (free, no secret).
- `…_paid_unlock_browse` — list the public shop feed (free, opt-in listings only).
- `…_paid_unlock_buy` — returns the REST endpoint + body to settle (the agent's
  x402 client pays at the REST surface; the secret is never handed over the
  free transport).

## Configuration

| Env | Default | Meaning |
| --- | --- | --- |
| `PAID_UNLOCK_ENABLED` | `false` | Master switch. |
| `PAID_UNLOCK_DB` | `/var/lib/payments-gateway/paid-unlock.db` | SQLite path. |
| `PAID_UNLOCK_FREE_CREATE_PER_IP_PER_HOUR` | `12` | Listing-create throttle. |
| `PAID_UNLOCK_ORDER_TTL_SEC` | `1800` | How long a buyer has to pay a native order. |

Reuses, rather than re-declares:

- `PRIVATE_WATCH_ENCRYPTION_KEY` — seals secrets at rest.
- `ZEC_RECV_ADDRESS` / `XMR_RECV_ADDRESS` + `CRYPTO_*` price oracle &
  confirmations — native pay quotes.
- `X402_RECIPIENT_ADDRESS` + the x402 paywall — instant USDC buys.

A native chain is only offered when its receiving address is configured; the
USDC buy only when the x402 paywall is enabled.

## Payment detection (native)

Automatic. The gateway's receive-poller (`bin/crypto-recv-poller.mjs`, the same
timer that confirms credit top-ups) reconciles unlock orders on every tick when
`PAID_UNLOCK_ENABLED`. It runs **one** view-key wallet scan per chain and feeds
the result to both the top-up matcher and `runUnlockRecvReconcile()`
(`src/paid-unlock-poller.js`), which:

1. matches an inbound payment to an open order by `(chain, exact amount, Zcash
   memo / Monero amount-tag)` — reusing the top-up poller's pure matchers
   (`matchIncoming`/`computeConfirmations`) verbatim, so detection is identical
   to the rest of the gateway;
2. enforces **fixed-price**: a memo-matched Zcash payment must cover the full
   quoted amount (no pro-rata); underpaid/garbled amounts are recorded as "seen"
   but never unlock;
3. once buried under enough confirmations, calls `markOrderPaid()`; the buyer
   then claims the secret.

The whole state machine is dependency-injected on `scan(chain)`, so it's
unit-tested against `:memory:` with zero network (`test/paid-unlock-poller.test.js`).
Native confirmation therefore activates automatically on any host that has a
ZEC/XMR receiving wallet **and** the recv-poller timer (e.g. Seneschal's
`*-crypto-recv-poller`); a host with only x402 configured (e.g. winbit32 today)
simply offers the instant USDC rail and doesn't advertise native chains.

## Browser demo

`public/paid-file.html` — a dependency-free WebCrypto page: encrypt a file
locally, create a listing, then (as a buyer) order, poll, claim and decrypt
on-device. Deploy it as a static asset (the standalone gateway serves no
static files itself).

## Source map

| File | Role |
| --- | --- |
| `src/paid-unlock.js` | Pure helpers: validation, seal/open, native-quote builder, projections, visibility. |
| `src/paid-unlock-store.js` | SQLite: `unlock_listings` + `unlock_orders`, discovery feed, claim accounting, stats, prune, migration. |
| `src/paid-unlock-routes.js` | Fastify routes (listing/listings/order/claim + x402 buy). |
| `src/paid-unlock-poller.js` | Native receive reconciler (`runUnlockRecvReconcile`). |
| `src/mcp-tools.js` | `registerPaidUnlockMcpTools` (info/listing/browse/buy), gated opt-in. |
| `public/paid-file.html` | Browser encrypt/decrypt demo + shop browse. |
| `test/paid-unlock*.test.js` | Helpers, store, poller, routes and MCP coverage. |

## Roadmap

- **Phase-2 — platform-blind delivery (deferred, by design):** the goal is that
  the gateway never sees the *key* even at release — the
  paidprivatefile.zkglobalcredit.tech model (key + ciphertext browser-to-browser
  over the **Nym mixnet**). This is genuine R&D, not a quick add, because of a
  hard constraint: we hold the only sealed copy and the buyer is unknown at seal
  time, so any "re-encrypt to the buyer" still passes the plaintext key *through*
  us. True blindness therefore requires **either**:
    1. **Both parties online for a P2P exchange** (seller's browser encrypts the
       key to the buyer's ephemeral public key and relays it over Nym; we only
       carry an opaque blob). Best privacy; needs the seller online at purchase.
    2. **A blind store-and-forward**: the seller pre-encrypts the key to a
       *per-listing* buyer-agnostic scheme and a store holds the blob it can't
       read; payment releases a decryptor. Avoids "seller online" but is a
       fair-exchange problem.
  V1 deliberately ships the honest, valuable half now: the **plaintext file
  never touches us** and **payment is non-custodial** — we only ever see the
  sealed key at the instant of delivery. The marginal gain of Nym (not seeing
  the key at that instant either) is real but incremental and is parked until
  there's demand for network-level metadata privacy.
- **Per-seller view keys (multi-tenant):** each seller supplies their own UFVK
  so the receiving wallet is theirs, scanned per-listing. Today the receiving
  wallet is the operator's.
- **Webhook-on-paid:** optional HMAC-signed "you sold one" callback (reusing the
  private-watch webhook signer).
