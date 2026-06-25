# payments-gateway

A generic MCP + REST payments gateway: charge for **your** services — and
let **your agents** accept payment for theirs — without ever holding a
spending key. Public, MIT.

Brand is config, not code. The same engine runs
[seneschal.space](https://seneschal.space) and Winbit32's
[mcp.winbit32.com](https://mcp.winbit32.com/mcp)
([winbit32MCP](https://github.com/FungeLLC/winbit32MCP) is a thin
deployment of this repo); point the env at your own name, prices and
addresses and it is your gateway.

## Two ways to get paid

**Direct payment with confirmation**

- **x402 (USDC)** — any REST route in your catalogue answers
  `402 Payment Required`; agents pay per-call with
  `transferWithAuthorization` on Base and retry. Micro-prices (a $0.001
  "Penny Oracle" tier) up to per-route pricing, with Bazaar discovery.
- **Outbound ZEC with a human in the loop** — `make_payment` builds a
  shielded transaction from a FROST vault, returns a `cosignUrl` deep link
  + `WB32COSIGN` QR, and the payment exists only once a human co-signs it
  in their cosigner. The gateway's share alone cannot spend.

**Top-up and use**

- Credit-metered services (e.g. view-key payment watches): create once,
  then meter down. Top up the meter with x402 (`/v1/private/topup*`,
  fixed tiers or custom amounts) **or by paying in XMR/ZEC** to your
  view-only receiving wallet — a quote locks the rate, a unique
  amount-tag/memo identifies the payer, and the receive poller credits
  the meter when funds land. No accounts, no cards, no custodial balance.
- **Spend that meter at ANY x402 endpoint** (`POST /v1/pay`, tool
  `pay_x402`) — the payer relay. **DORMANT / EXPERIMENTAL — kept off.**
  A funded account *could* pay a third-party x402 server through the
  gateway (gateway fronts USDC from a hot float, settles the merchant's
  402 challenge capped, returns the response, debits amount + fee), with
  reserve→pay→settle→refund accounting and auditable `relay_payments`
  receipts. It stays off (no host-injected `opts.x402Payer` ⇒ every call
  503s) because this custodial *hold-then-transmit-to-third-parties* shape
  is money-transmission-shaped. The **non-custodial successor** — the
  user's OWN Vultisig vault swaps (Maya/NEAR-Intents) and signs the x402
  payment, no custody by us — is planned in **winbit32**. The code here is
  retained and tested but is not the product direction.

## Key custody

The **recommended** mode is split-key: the gateway process holds at most
**one FROST share of a t-of-n key** (a `.wult` file). Any tool that moves
funds returns a cosign QR / deep link; a human approves in a cosigner
(the fast-boot [winbit32.com/cosign](https://winbit32.com/cosign) app,
cosign.exe in the Winbit32 desktop, or any WB32COSIGN-speaking signer).
The human's share signature IS the approval; nothing the gateway can sign
alone.

That is the recommended mode, not the only one: signing tools also accept
directly supplied phrases or keys (operator config or explicit tool input)
for operators who accept holding key material. Docs and defaults steer
towards split-key; functionality is never gated on it.

For *accepting* payments the gateway is view-key-only: it can see funds
arrive but can never move them.

## Tool families

| Family | Tools | Keys needed |
| --- | --- | --- |
| accept | view-key watches + HMAC webhooks, x402 paywall, XMR/ZEC top-up quotes | view keys only |
| unlock *(opt-in)* | `paid_unlock_info/listing/browse/buy` (REST `/v1/unlock/*`) — pay-to-reveal a sealed secret ("paid private file"): non-custodial ZEC/XMR (auto-confirmed) or USDC, with an opt-in public shop feed | view keys + the existing master key (sealing) |
| make | `make_payment`, `make_payment_status`, `make_payment_info` | one FROST share + human cosign (recommended), or a directly supplied phrase/key |
| relay *(dormant)* | `pay_x402`, `pay_x402_info` (REST `POST /v1/pay`) — custodial spend-anywhere, kept OFF (money-transmission-shaped); non-custodial successor planned in winbit32 | host-injected funded payer (`opts.x402Payer`); a Base USDC float |
| wallet | balances, scan jobs, UTXOs, broadcast | view keys only |
| utility | phrase validate/complete/generate, Shamir split/combine | none (local, offline) |
| info | single-fact chain queries (height/fee/mempool) | none |
| zcash amounts | `zec_amount_advice`, `zec_split_plan`, `zec_popular_amounts` (REST `GET /v1/zec/amount-advice`, `/v1/zec/split-plan`, `/v1/zec/popular-amounts`) — "blend in" shield/deshield amount advice, a large-amount split planner, and the live popular-amount histogram | none (read); a zebra node + the index poller for live counts |
| zcash bus (opt-in) | `zec_bus_list`, `zec_bus_join`, `zec_bus_status`, `zec_bus_board`, `zec_bus_leave` (REST `GET /v1/zec/bus`, `GET /v1/zec/bus/:id`, `POST /v1/zec/bus/join`, `POST /v1/zec/bus/seat/:id/board\|leave`) — **non-custodial** mixing coordination: many users leave the Zcash pool with the same blend-in amount/route in the same window so their swaps look identical on-chain. The gateway holds no funds/keys and stores no destinations/txids — pure rendezvous. | `ZEC_BUS_ENABLED=1` + a writable `ZEC_BUS_DB` (no read-only fallback) |

## Built on

One source of truth, assembled from already-public packages:

- [`x402-server-kit`](https://github.com/Rotwang9000/x402-server-kit) —
  generic Fastify x402 paywall (facilitator selection, validated config,
  Bazaar discovery);
- [`viewkey-watch`](https://github.com/Rotwang9000/viewkey-watch) —
  Monero/Zcash view-key watch engine, credit meter and XMR/ZEC top-up
  detection;
- [`@winbit32/wallet-kit`](https://www.npmjs.com/package/@winbit32/wallet-kit)
  — scanner clients + the WB32COSIGN FROST/Orchard cosign client
  (headless initiator pipeline) used by the wallet tools and
  `make_payment`.

## What works today

| Capability | Status |
| --- | --- |
| Accept USDC per-call via x402 (HTTP 402 + `transferWithAuthorization` on Base) | ✅ |
| View-key payment **webhooks** for Monero/Zcash ("ping me when funds land") | ✅ |
| Credit-metered watches with USDC top-ups (fixed tiers + custom amounts) | ✅ |
| Fund a watch by paying in **XMR/ZEC** to the operator's view-only wallet | ✅ |
| One-off historical view-key scans (spendable/spent notes) | ✅ |
| Free view-key derivation from a phrase (rate-limited) | ✅ |
| Single-fact ("Penny Oracle") privacy-chain queries (height/fee/mempool) | ✅ |
| Zcash amount-privacy advisor (free): "blend in" shield/deshield amounts + round-trip self-dox warning + large-amount split planner, with a live on-chain popular-amount index ("N others used this") | ✅ |
| **Make** outbound **ZEC** payments via FROST co-signing, with `cosignUrl` deep links | ✅ |
| Wallet view-key tools (`*_zec_scan_*`, `*_zec_utxos`, `*_zec_broadcast`, `*_xmr_scan_*`) | ✅ |
| Utility tools: `phrase_validate/complete/generate`, `shamir_split/combine` — local + offline | ✅ |
| **Paid unlock** ("paid private file"): seal a secret, sell it for ZEC/XMR (view-key, auto-confirmed) or USDC (x402); opt-in public shop feed; browser-encrypt demo — opt-in | ✅ |
| Platform-blind paid-file delivery over **Nym** (key + ciphertext browser-to-browser) | 🛣️ roadmap |
| Direct phrase/key signing mode; outbound USDC / XMR | 🛣️ roadmap |

## Running it standalone

```bash
npm ci
node bin/mcp.mjs     # MCP server for agents (Streamable HTTP)
node bin/rest.mjs    # REST + x402 paywall
node bin/private-watch-poller.mjs    # watch poller (cron-style)
node bin/crypto-recv-poller.mjs      # XMR/ZEC top-up poller
node bin/zec-shield-index-poller.mjs # Zcash shield-amount index (opt-in)
```

Agent config:

```json
{ "mcpServers": { "myservice": { "url": "https://mcp.example.com/mcp" } } }
```

## Embedding it

Mount the engine onto your own Fastify + MCP servers and inject your
config — your routes and the gateway's paid routes share one paywall:

```js
import {
	buildConfig,
	registerGatewayRoutes,
	registerGatewayMcpTools
} from 'payments-gateway';

const cfg = buildConfig({ ...process.env, GATEWAY_SERVICE_NAME: 'myservice' });

// REST: your Fastify app gains the gateway's paid routes + paywall. To
// paywall your own routes too, build a combined x402Cfg from
// GATEWAY_PREMIUM_ROUTES.concat(yourRoutes) and pass it in opts.
registerGatewayRoutes(app, { config: cfg });

// MCP: your server gains the gateway tool families under your prefix.
registerGatewayMcpTools(mcpServer, { config: cfg, toolPrefix: 'myservice' });
```

Install as a dependency:

```bash
npm i github:Rotwang9000/payments-gateway
```

## Agent discovery (Gopher over HTTPS)

So agents can *find* your services cheaply — before they spend tokens on
an HTML page or a JSON index — the gateway ships a tiny, dependency-free
primitive for serving a [Gopher](https://datatracker.ietf.org/doc/html/rfc1436)
menu natively over HTTPS. The convention: publish a terse, drill-down
service index at **`/.well-known/agent.gopher`** with
`Content-Type: application/gopher; charset=utf-8`. It is a typed, navigable
cousin of [`llms.txt`](https://llmstxt.org) — a discovery layer, **not** a
replacement for MCP (which is how you *call* a tool).

The `gophermap` module builds, parses and sanitises menus (RFC 1436) in a
TLS-native "compact" mode that drops Gopher's redundant host/port fields:

```js
import {
	info, menu, textItem, link, buildMenu
} from 'payments-gateway/gophermap';

// Compact mode is the default (host + port dropped — TLS supplies them).
const body = buildMenu([
	info('My services — terse index for machines.'),
	menu('Catalogue', '/.well-known/agent/catalogue'),
	textItem('about', '/.well-known/agent/about'),
	link('MCP server', 'https://mcp.example.com/')
]);

app.get('/.well-known/agent.gopher', (req, reply) =>
	reply
		.header('content-type', 'application/gopher; charset=utf-8')
		.header('cache-control', 'public, max-age=600')
		.send(body));
```

A line is just `<type><label>TAB<selector>` (`1` submenu, `0` text leaf,
`h` `URL:` link, `i` info), terminated by a line containing only `.`.
Across a real directory the compact menu measures ~29% smaller than the
equivalent JSON and ~32% smaller than minimal HTML, and progressive
disclosure (drilling into one branch) is ~5× cheaper than pulling a whole
index. Live example + a "publish your own" walkthrough:
[seneschal.space/gopher](https://seneschal.space/gopher) — served from
[`seneschal.space/.well-known/agent.gopher`](https://seneschal.space/.well-known/agent.gopher).

## Configuration

Environment-driven via `src/config.js` (`buildConfig(env)`). Key groups:

- **Server**: `GATEWAY_REST_PORT`, `GATEWAY_MCP_PORT`, `GATEWAY_REST_HOST`
- **Brand**: `GATEWAY_SERVICE_NAME`, `GATEWAY_TOOL_PREFIX`,
  `GATEWAY_WEBHOOK_SIGNATURE_HEADER`
- **x402**: `X402_RECIPIENT_ADDRESS`, `X402_NETWORK`, `X402_FACILITATOR_URL`,
  `X402_CDP_API_KEY_ID` / `X402_CDP_API_KEY_SECRET`, `X402_*_PRICE`
- **Scanner backend**: `NFPT_BASE_URL`, `NFPT_API_KEY`
- **Private watch**: `PRIVATE_WATCH_DB`, `PRIVATE_WATCH_ENCRYPTION_KEY`
- **Privacy RPC**: `MONERO_RPC_URL`, `ZCASH_RPC_URL`
- **Zcash shield-amount index** *(read always on; scanner opt-in)*:
  `ZEC_SHIELD_INDEX_ENABLED`, `ZEC_SHIELD_INDEX_DB`,
  `ZEC_SHIELD_INDEX_FROM_HEIGHT` / `ZEC_SHIELD_INDEX_WINDOW_BLOCKS`,
  `ZEC_SHIELD_INDEX_MAX_BLOCKS_PER_TICK`, `ZEC_SHIELD_INDEX_MIN_BOUNDARY_ZAT`
  (drives the `zec_amount_advice` / `zec_popular_amounts` tools + `/v1/zec/*`
  routes; reads the zebra node, no view keys)
- **XMR/ZEC top-ups**: `XMR_RECV_ADDRESS` + `XMR_RECV_VIEW_KEY`,
  `ZEC_RECV_ADDRESS` + `ZEC_RECV_UFVK`, `CRYPTO_TOPUP_*`
- **Make payments (ZEC co-sign)**: `MAKE_PAYMENT_WULT_PATH` (+ optional
  `MAKE_PAYMENT_WULT_PASSWORD`), `MAKE_PAYMENT_WASM_DIR` (orchard-frost WASM
  artefacts), `MAKE_PAYMENT_RELAY_URL` (default `https://cosign.winbit32.com`),
  `MAKE_PAYMENT_PCZT_API_BASE`, `MAKE_PAYMENT_SCANNER_BASE`,
  `MAKE_PAYMENT_BIRTHDAY_HEIGHT`, the safety rails
  `MAKE_PAYMENT_MAX_ZEC` / `MAKE_PAYMENT_MAX_PENDING`, and
  `COSIGN_APP_URL` for the human-facing cosigner deep links.
- **Paid unlock** ("paid private file"): `PAID_UNLOCK_ENABLED`,
  `PAID_UNLOCK_DB`, `PAID_UNLOCK_FREE_CREATE_PER_IP_PER_HOUR`,
  `PAID_UNLOCK_ORDER_TTL_SEC`. Reuses `PRIVATE_WATCH_ENCRYPTION_KEY` (sealing),
  the `ZEC_RECV_*` / `XMR_RECV_*` wallet + `CRYPTO_*` oracle (native quotes) and
  the x402 paywall (USDC buys).

A capability stays `503 *_not_configured` (or its tools are simply not
registered) until its keys/addresses are set — the `make_payment` tools
only exist when `MAKE_PAYMENT_WULT_PATH` is configured, and the paid-unlock
surface only mounts when `PAID_UNLOCK_ENABLED=1`.

## Paid unlock ("paid private file")

Opt-in pay-to-reveal: a seller seals a small secret (a file decryption key +
locator, a licence, a link) behind a price; a buyer pays **non-custodially** in
ZEC/XMR (detected with a view key — funds go straight to the seller, and the
receive-poller auto-confirms the order) or instantly in USDC over x402, then
pulls the secret. The file plaintext never touches the server (encrypt
in-browser, host only the ciphertext); the secret is sealed at rest with the
gateway master key. Sellers can opt a listing into a public **shop feed**
(`GET /v1/unlock/listings`) or keep it link-only (default). Full trust model,
API surface, the native auto-confirm reconciler and the WebCrypto browser demo:
[`docs/PAID_UNLOCK.md`](docs/PAID_UNLOCK.md).

## Deployments

- **[winbit32MCP](https://github.com/FungeLLC/winbit32MCP)** — the Winbit32
  deployment, live at `https://mcp.winbit32.com/mcp` (tool prefix
  `winbit32`).
- **seneschal.space** — embedded alongside its own DeFi feeds (combined
  x402 route catalogue).

## Licence

MIT — see [LICENSE](LICENSE).
