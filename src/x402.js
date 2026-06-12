// x402 paywall wiring — gateway adapter over the open-source
// `x402-server-kit` package.
//
// The generic engine (config validation, facilitator selection, @x402/fastify
// registration, Bazaar discovery, paywall description) lives in
// x402-server-kit. This module keeps only the gateway-specific glue:
//   - the default route catalogue (GATEWAY_PREMIUM_ROUTES),
//   - per-route price resolution (env var → cfg → feed default),
//   - reading CDP credentials out of an injected config object.
//
// Everything takes `cfg` as a parameter (defaulting to the standalone gateway
// config) so an embedding host can pass its own config + a *combined* route
// list and register a single paywall covering both products' paid routes.

import gatewayConfig from './config.js';
import { GATEWAY_PREMIUM_ROUTES } from './x402-routes.js';
import {
	buildX402Config as kitBuildX402Config,
	createFacilitatorClient as kitCreateFacilitatorClient,
	registerX402 as kitRegisterX402,
	describePaywall,
	discoveryConfigForRouteKey,
	assertPrice,
	CDP_FACILITATOR_URL
} from 'x402-server-kit';

export { describePaywall, discoveryConfigForRouteKey, assertPrice, CDP_FACILITATOR_URL };
export { GATEWAY_PREMIUM_ROUTES } from './x402-routes.js';

// X402_FEED_PRICE -> x402FeedPrice (camelCase). Lets a cfg field win if the
// operator pinned a price that way rather than via the env var.
function envKeyToCfg(envKey) {
	const parts = envKey.toLowerCase().split('_');
	return parts.map((p, i) => i === 0 ? p : p.charAt(0).toUpperCase() + p.slice(1)).join('');
}

// CDP credentials live only in the config object; pull them out at dispatch
// time and hand them to the kit (which never stores them on the frozen
// x402Cfg, so they can't leak through describePaywall).
function cdpCredsFrom(cfg) {
	return {
		cdpApiKeyId: (cfg.x402CdpApiKeyId || '').trim(),
		cdpApiKeySecret: (cfg.x402CdpApiKeySecret || '').trim()
	};
}

/**
 * Resolve each route's price from env → cfg → feed default, returning the
 * shape x402-server-kit expects. Exported so a host can resolve a combined
 * catalogue (gateway routes + its own) before building the config.
 */
export function resolveRoutePrices(routes, { cfg = gatewayConfig, env = process.env } = {}) {
	return routes.map((r) => ({
		method: r.method,
		path: r.path,
		price: (env[r.priceEnvKey] || cfg[envKeyToCfg(r.priceEnvKey)] || cfg.x402FeedPrice || '$0.05').trim(),
		description: r.description,
		mimeType: r.mimeType,
		// Bazaar discovery enrichment (inputSchema/output) rides through
		// to x402-server-kit, which folds it into the declared extension.
		...(r.discovery ? { discovery: r.discovery } : {})
	}));
}

/**
 * Validate config and return the normalised x402 view. `routes` defaults to
 * the gateway's own catalogue; a host passes a combined list to gate both
 * products with one paywall. Returns `{ enabled: false, reason }` when the
 * paywall is intentionally off, or throws if env vars are malformed.
 */
export function buildX402Config({ cfg = gatewayConfig, env = process.env, routes = GATEWAY_PREMIUM_ROUTES } = {}) {
	const recipient = (cfg.x402RecipientAddress || '').trim();
	const enabled = cfg.x402Enabled || Boolean(recipient);
	if (!enabled) {
		return Object.freeze({ enabled: false, reason: 'X402_RECIPIENT_ADDRESS not set' });
	}
	return kitBuildX402Config({
		recipient,
		routes: resolveRoutePrices(routes, { cfg, env }),
		network: (cfg.x402Network || 'eip155:8453').trim(),
		facilitatorUrl: (cfg.x402FacilitatorUrl || '').trim(),
		maxTimeoutSeconds: cfg.x402MaxTimeoutSeconds ?? 120,
		...cdpCredsFrom(cfg)
	});
}

/**
 * Build the facilitator client the paywall dispatches verify/settle to.
 * Reads CDP creds from `cfg` at dispatch time.
 */
export async function createFacilitatorClient(x402Cfg, { cfg = gatewayConfig } = {}) {
	return kitCreateFacilitatorClient(x402Cfg, cdpCredsFrom(cfg));
}

/**
 * Install the paywall on an existing Fastify app, passing CDP creds from `cfg`.
 */
export async function registerX402(app, x402Cfg, { cfg = gatewayConfig } = {}) {
	return kitRegisterX402(app, x402Cfg, cdpCredsFrom(cfg));
}
