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
	registerNoticeBoardMcpTools,
	registerPaidUnlockMcpTools,
	registerMakePaymentMcpTools,
	registerWalletKitMcpTools,
	registerUtilityMcpTools,
	registerZcashAmountMcpTools,
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
	BOARD_CONSTANTS,
	sanitiseText,
	normaliseHandle,
	validateUrl,
	normaliseTags,
	normaliseBoards,
	validatePostRequest,
	validateBoostAmount,
	atomicToUsd,
	effectiveWeight,
	sortNotices,
	buildNoticeSummary,
	buildBoardRss,
	buildBoardJsonFeed,
	escapeXml,
	verifyOwner
} from './notice-board.js';

export {
	openBoardDb,
	createNotice,
	getNotice,
	listNotices,
	countNotices,
	boostNotice,
	editNotice,
	withdrawNotice,
	removeNotice,
	reportNotice,
	statsSnapshot as noticeBoardStatsSnapshot,
	topBoostedNotices,
	pruneOld as pruneNotices
} from './notice-board-store.js';

export { registerNoticeBoardRoutes } from './notice-board-routes.js';

// ── Paid unlock ("paid private file"): pay-to-reveal a sealed secret ──
export {
	UNLOCK_CONSTANTS,
	genUnlockId,
	genClaimToken,
	usdCentsToUsdcAtomic,
	validateListingRequest,
	sealSecret,
	openSecret,
	buildNativeQuote,
	publicListing,
	publicOrder,
	buildOrderInstructions
} from './paid-unlock.js';

export {
	openUnlockDb,
	createListing,
	getListing,
	isListingOpen,
	withdrawListing,
	listPublicListings,
	createOrder,
	getOrder,
	getOrderAuthorised,
	markOrderSeen,
	markOrderPaid,
	claimOrder,
	hasOpenOrderWithAmount,
	expireStaleOrders,
	listMatchableOrders,
	statsSnapshot as paidUnlockStatsSnapshot,
	pruneOld as pruneUnlock
} from './paid-unlock-store.js';

export { registerPaidUnlockRoutes } from './paid-unlock-routes.js';

export { runUnlockRecvReconcile, paymentCoversOrder } from './paid-unlock-poller.js';

export {
	monRpc,
	zecRpc,
	qXmrHeight,
	qXmrMempool,
	qXmrFee,
	qXmrFeeEstimate,
	qXmrLastBlock,
	qZecHeight,
	qZecMempool,
	qZecLastBlock,
	CHAIN_QUESTION_REGISTRY,
	dispatchChainQuestion,
	createChainCache
} from './queries-q-chain.js';

// ── Zcash amount-privacy advisor (blend-in amounts) + on-chain index ──
export {
	ZATOSHIS_PER_ZEC,
	COMMON_AMOUNTS_ZEC,
	MIN_BOUNDARY_ZAT_DEFAULT,
	zecToZats,
	zatsToZec,
	formatZec,
	isCommonAmount,
	suggestAmounts,
	classifyAmount,
	assessRoundTripRisk,
	summariseNoteAmounts,
	assessNotePrivacy,
	parseAmountList,
	buildAmountAdvice,
	classifyBoundaryTx,
	txNetShieldedZat,
	transparentVoutZat,
	transparentVinCount,
	isCoinbaseTx,
	hasShieldedComponent
} from './zcash-amount-privacy.js';

export {
	SHIELD_SIDES,
	openShieldIndexDb,
	openSharedShieldIndexDb,
	bumpAmount,
	popularAmounts,
	nearbyAmounts,
	exactCount,
	statsSnapshot as shieldIndexStatsSnapshot,
	buildPopularFeed,
	pruneRareAmounts,
	getCursor as shieldIndexGetCursor,
	setCursor as shieldIndexSetCursor,
	fetchTipHeight,
	scanShieldAmounts
} from './zcash-shield-index.js';

export { registerZcashAmountRoutes } from './zcash-amount-routes.js';
