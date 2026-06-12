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
| make | `make_payment`, `make_payment_status`, `make_payment_info` | one FROST share + human cosign (recommended), or a directly supplied phrase/key |
| wallet | balances, scan jobs, UTXOs, broadcast | view keys only |
| utility | phrase validate/complete/generate, Shamir split/combine | none (local, offline) |
| info | single-fact chain queries (height/fee/mempool) | none |

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
| **Make** outbound **ZEC** payments via FROST co-signing, with `cosignUrl` deep links | ✅ |
| Wallet view-key tools (`*_zec_scan_*`, `*_zec_utxos`, `*_zec_broadcast`, `*_xmr_scan_*`) | ✅ |
| Utility tools: `phrase_validate/complete/generate`, `shamir_split/combine` — local + offline | ✅ |
| Direct phrase/key signing mode; outbound USDC / XMR | 🛣️ roadmap |

## Running it standalone

```bash
npm ci
node bin/mcp.mjs     # MCP server for agents (Streamable HTTP)
node bin/rest.mjs    # REST + x402 paywall
node bin/private-watch-poller.mjs    # watch poller (cron-style)
node bin/crypto-recv-poller.mjs      # XMR/ZEC top-up poller
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
- **XMR/ZEC top-ups**: `XMR_RECV_ADDRESS` + `XMR_RECV_VIEW_KEY`,
  `ZEC_RECV_ADDRESS` + `ZEC_RECV_UFVK`, `CRYPTO_TOPUP_*`
- **Make payments (ZEC co-sign)**: `MAKE_PAYMENT_WULT_PATH` (+ optional
  `MAKE_PAYMENT_WULT_PASSWORD`), `MAKE_PAYMENT_WASM_DIR` (orchard-frost WASM
  artefacts), `MAKE_PAYMENT_RELAY_URL` (default `https://cosign.winbit32.com`),
  `MAKE_PAYMENT_PCZT_API_BASE`, `MAKE_PAYMENT_SCANNER_BASE`,
  `MAKE_PAYMENT_BIRTHDAY_HEIGHT`, the safety rails
  `MAKE_PAYMENT_MAX_ZEC` / `MAKE_PAYMENT_MAX_PENDING`, and
  `COSIGN_APP_URL` for the human-facing cosigner deep links.

A capability stays `503 *_not_configured` (or its tools are simply not
registered) until its keys/addresses are set — the `make_payment` tools
only exist when `MAKE_PAYMENT_WULT_PATH` is configured.

## Deployments

- **[winbit32MCP](https://github.com/FungeLLC/winbit32MCP)** — the Winbit32
  deployment, live at `https://mcp.winbit32.com/mcp` (tool prefix
  `winbit32`).
- **seneschal.space** — embedded alongside its own DeFi feeds (combined
  x402 route catalogue).

## Licence

MIT — see [LICENSE](LICENSE).
