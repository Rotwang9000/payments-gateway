// payments-gateway — public barrel.
//
// Re-exports the building blocks a host needs to embed the gateway, plus the
// gateway's own config + x402 helpers. The view-key scanning/store/pricing
// primitives live in `viewkey-watch`; import those directly where needed.

export { buildConfig, config, default as gatewayConfig } from './config.js';

// ── Servers: run the gateway standalone or mount it inside your own app ──
export {
	asContent,
	registerGatewayMcpTools,
	registerMakePaymentMcpTools,
	registerWalletKitMcpTools,
	registerUtilityMcpTools,
	buildGatewayMcpServer,
	startGatewayMcpHttpServer
} from './mcp-tools.js';

export { buildGatewayApp, startGatewayRest } from './rest-app.js';
export { registerGatewayRoutes } from './rest-plugin.js';

// ── Outbound co-signed ZEC (direct pay with human confirmation) ──
export {
	createMakePaymentService,
	buildCosignDeepLink,
	progressToStatus,
	PAYMENT_STATUSES
} from './make-payment.js';
export { buildMakePaymentDeps, loadOrchardFrostWasmNode } from './make-payment-deps.js';

// ── Local, offline secret-hygiene utilities (optional MCP tools) ──
export {
	validatePhrase,
	findChecksumWords,
	generatePhrase,
	splitSecretHex,
	combineSecretShares
} from './utility-tools.js';

export {
	buildX402Config,
	createFacilitatorClient,
	registerX402,
	resolveRoutePrices,
	describePaywall,
	discoveryConfigForRouteKey,
	assertPrice,
	CDP_FACILITATOR_URL
} from './x402.js';

export { GATEWAY_PREMIUM_ROUTES, qFact } from './x402-routes.js';

export {
	CUSTOM_TOPUP_LIMITS,
	validateCustomTopupRequest,
	buildCustomPaymentRequirements,
	encodeChallenge,
	decodePaymentHeader,
	registerCustomTopupRoute
} from './private-watch-custom.js';

export {
	validateCryptoTopupRequest,
	withMoneroTag,
	generateMemo,
	formatUsdCents,
	buildInstructions,
	publicQuote,
	registerCryptoTopupRoutes
} from './private-watch-crypto-topup.js';

export {
	monRpc,
	zecRpc,
	qXmrHeight,
	qXmrMempool,
	qXmrFee,
	qXmrLastBlock,
	qZecHeight,
	qZecMempool,
	qZecLastBlock,
	CHAIN_QUESTION_REGISTRY,
	dispatchChainQuestion,
	createChainCache
} from './queries-q-chain.js';
