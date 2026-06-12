// The gateway's x402 premium-route catalogue. These are the *payment* routes —
// Monero/Zcash view-key webhooks (Private Watch) and the privacy-chain
// single-fact ("Penny Oracle") queries. A host that also serves other paid
// routes (e.g. Seneschal's DeFi feeds) concatenates its own catalogue with
// this one before handing the combined list to x402-server-kit.
//
// @x402/fastify matches `"METHOD /path"` exactly (no wildcards), so each path
// is enumerated explicitly.
//
// Each route carries a `discovery` object (inputSchema + output.schema in
// plain JSON-schema) that x402-server-kit folds into the Bazaar discovery
// extension. Indexers score listings on these — x402scan flags a missing
// output schema as an error and CDP's Bazaar ranks schema-complete entries —
// so they are required here for any new route, compact by design: field
// names, types and required-ness, not every validation refine.

// Shared schema fragments. Kept as plain frozen objects (not zod) so the
// catalogue stays dependency-free and serialises into the 402 challenge
// verbatim.
// Mirrors viewkey-watch's buildCreditBlock verbatim (snake_case) —
// indexers compare declared schemas against real responses.
const CREDIT_BLOCK_SCHEMA = Object.freeze({
	type: 'object',
	properties: {
		remaining_atomic: { type: 'string', description: 'Remaining credit in atomic USDC (6 decimals).' },
		remaining_usd: { type: 'string' },
		billed_atomic: { type: 'string' },
		billed_usd: { type: 'string' },
		topups_atomic: { type: 'string' },
		topups_usd: { type: 'string' },
		rate_per_day_atomic: { type: 'string' },
		rate_per_day_usd: { type: 'string' },
		rate_per_call_atomic: { type: 'string' },
		rate_per_call_usd: { type: 'string' },
		days_remaining_if_idle: { type: 'number' },
		low_credit: { type: 'boolean' },
		low_credit_threshold_atomic: { type: 'string' },
		low_credit_threshold_usd: { type: 'string' }
	}
});

const TOPUP_INPUT_SCHEMA = Object.freeze({
	type: 'object',
	required: ['watchId', 'watchToken'],
	properties: {
		watchId: { type: 'string', description: 'Watch identifier from POST /v1/private/watch.' },
		watchToken: { type: 'string', description: 'Bearer credential returned at watch creation. Secret.' }
	}
});

// Example bodies/responses embedded in the public Bazaar catalogue.
// Placeholder values only — never real credentials or addresses.
const TOPUP_INPUT_EXAMPLE = Object.freeze({
	watchId: 'w_3f9c2e1a',
	watchToken: '<watch-token-from-create>'
});

const CREDIT_BLOCK_EXAMPLE = Object.freeze({
	remaining_atomic: '120000',
	remaining_usd: '$0.12',
	billed_atomic: '5000',
	billed_usd: '$0.005',
	topups_atomic: '100000',
	topups_usd: '$0.10',
	rate_per_day_atomic: '20000',
	rate_per_day_usd: '$0.02',
	rate_per_call_atomic: '5000',
	rate_per_call_usd: '$0.005',
	days_remaining_if_idle: 6,
	low_credit: false,
	low_credit_threshold_atomic: '40000',
	low_credit_threshold_usd: '$0.04'
});

const TOPUP_OUTPUT_SCHEMA = Object.freeze({
	type: 'object',
	properties: {
		watchId: { type: 'string' },
		tier: { type: 'string', description: 'Which top-up route was used.' },
		creditAppliedAtomic: { type: 'string' },
		credit: CREDIT_BLOCK_SCHEMA,
		expiresAt: { type: 'string', format: 'date-time' }
	}
});

const topupOutputExample = (tier, applied) => Object.freeze({
	watchId: 'w_3f9c2e1a',
	tier,
	creditAppliedAtomic: applied,
	credit: CREDIT_BLOCK_EXAMPLE,
	expiresAt: '2026-07-12T00:00:00.000Z'
});

/**
 * Build an atomic single-fact ("Penny Oracle") route descriptor. All such
 * routes share the micro price tier (`X402_Q_PRICE`, default $0.001) so agents
 * can hammer them in tight loops without subscription friction.
 *
 * Discovery enrichment (all optional, but provide them for new routes —
 * indexers grade listings on schema completeness):
 *   `outputProps`    JSON-schema property map for the response object.
 *   `outputExample`  Example response. REQUIRED for the output block to be
 *                    emitted at all: @x402/extensions only declares output
 *                    when an example is present, and validates the example
 *                    against the schema.
 *   `inputSchema`    JSON schema for the query params.
 *   `inputExample`   Example query-param values. Must satisfy inputSchema's
 *                    `required` list — the extension embeds the example as
 *                    `info.input.queryParams` and validators check it.
 */
export const qFact = (path, description, { outputProps = null, outputExample = null, inputSchema = null, inputExample = null } = {}) => Object.freeze({
	method: 'GET',
	path,
	description,
	mimeType: 'application/json',
	priceEnvKey: 'X402_Q_PRICE',
	discovery: Object.freeze({
		...(inputSchema ? { inputSchema } : {}),
		...(inputExample ? { input: inputExample } : {}),
		...((outputProps || outputExample) ? {
			output: {
				...(outputExample ? { example: outputExample } : {}),
				schema: {
					type: 'object',
					...(outputProps ? { properties: outputProps } : {})
				}
			}
		} : {})
	})
});

export const GATEWAY_PREMIUM_ROUTES = Object.freeze([
	// === Private Watch — Monero/Zcash view-key payment webhooks ===
	Object.freeze({
		method: 'POST',
		path: '/v1/private/watch',
		description: 'Create a Monero or Zcash view-key payment watch. Body: { chain, address, viewKey, webhookUrl, birthdayHeight? }. Returns { watchId, watchToken, webhookSecret, expiresAt, creditAtomic } — the receiver verifies inbound webhooks with HMAC-SHA256(webhookSecret, body) and tops up via /v1/private/topup* before the meter runs dry.',
		mimeType: 'application/json',
		priceEnvKey: 'X402_PRIVATE_WATCH_PRICE',
		discovery: Object.freeze({
			inputSchema: {
				type: 'object',
				required: ['chain', 'address', 'viewKey', 'webhookUrl'],
				properties: {
					chain: { type: 'string', enum: ['monero', 'zcash'] },
					address: { type: 'string', description: 'Receiving address to watch.' },
					viewKey: { type: 'string', description: 'READ-ONLY view key (Monero private view key or Zcash UFVK). Cannot spend.' },
					webhookUrl: { type: 'string', format: 'uri', description: 'HTTPS endpoint that receives an HMAC-signed POST per inbound payment.' },
					birthdayHeight: { type: 'integer', description: 'Optional scan-from height (defaults to tip).' }
				}
			},
			input: {
				chain: 'monero',
				address: '<your-receiving-address>',
				viewKey: '<your-private-view-key-or-ufvk>',
				webhookUrl: 'https://example.com/webhooks/payments'
			},
			output: {
				example: {
					watchId: 'w_3f9c2e1a',
					watchToken: '<secret-bearer-token>',
					webhookSecret: '<hmac-sha256-key>',
					chain: 'monero',
					address: '<your-receiving-address>',
					creditAtomic: '20000',
					expiresAt: '2026-07-12T00:00:00.000Z',
					pollIntervalSec: 60,
					ratePerDayAtomic: '20000',
					ratePerCallAtomic: '5000',
					pricingTier: 'standard',
					topupEndpoints: { '10c': '/v1/private/topup', '1usd': '/v1/private/topup-1', '5usd': '/v1/private/topup-5' },
					testEndpoint: '/v1/private/watch/w_3f9c2e1a/test',
					signatureHeader: '<Signature-Header>: sha256=<HMAC-SHA256(webhookSecret, body)>'
				},
				schema: {
					type: 'object',
					properties: {
						watchId: { type: 'string' },
						watchToken: { type: 'string', description: 'Bearer credential for status/cancel/topup. Secret.' },
						webhookSecret: { type: 'string', description: 'HMAC-SHA256 key for verifying webhook deliveries.' },
						chain: { type: 'string' },
						address: { type: 'string' },
						creditAtomic: { type: 'string', description: 'Starter credit in atomic USDC.' },
						expiresAt: { type: 'string', format: 'date-time' },
						pollIntervalSec: { type: 'integer' },
						ratePerDayAtomic: { type: 'string' },
						ratePerCallAtomic: { type: 'string' },
						pricingTier: { type: 'string' },
						topupEndpoints: { type: 'object' },
						testEndpoint: { type: 'string' },
						signatureHeader: { type: 'string', description: 'How webhook deliveries are signed.' }
					}
				}
			}
		})
	}),
	Object.freeze({
		method: 'POST',
		path: '/v1/private/topup',
		description: 'Add $0.10 of credit (100_000 atomic USDC) to an existing watch. Body: { watchId, watchToken }. Returns the post-top-up credit block.',
		mimeType: 'application/json',
		priceEnvKey: 'X402_PRIVATE_TOPUP_PRICE',
		discovery: Object.freeze({ inputSchema: TOPUP_INPUT_SCHEMA, input: TOPUP_INPUT_EXAMPLE, output: { example: topupOutputExample('/v1/private/topup', '100000'), schema: TOPUP_OUTPUT_SCHEMA } })
	}),
	Object.freeze({
		method: 'POST',
		path: '/v1/private/topup-1',
		description: 'Add $1.00 of credit (1_000_000 atomic USDC) to an existing watch. Same body/response shape as /v1/private/topup.',
		mimeType: 'application/json',
		priceEnvKey: 'X402_PRIVATE_TOPUP_1_PRICE',
		discovery: Object.freeze({ inputSchema: TOPUP_INPUT_SCHEMA, input: TOPUP_INPUT_EXAMPLE, output: { example: topupOutputExample('/v1/private/topup-1', '1000000'), schema: TOPUP_OUTPUT_SCHEMA } })
	}),
	Object.freeze({
		method: 'POST',
		path: '/v1/private/topup-5',
		description: 'Add $5.00 of credit (5_000_000 atomic USDC) to an existing watch. Best value tier for high-volume receivers. Same body/response shape as /v1/private/topup.',
		mimeType: 'application/json',
		priceEnvKey: 'X402_PRIVATE_TOPUP_5_PRICE',
		discovery: Object.freeze({ inputSchema: TOPUP_INPUT_SCHEMA, input: TOPUP_INPUT_EXAMPLE, output: { example: topupOutputExample('/v1/private/topup-5', '5000000'), schema: TOPUP_OUTPUT_SCHEMA } })
	}),
	Object.freeze({
		method: 'POST',
		path: '/v1/private/historical',
		description: 'One-off historical scan of a Zcash UFVK or Monero address+viewKey. Returns spendable + spent note totals and (optional) per-note breakdown. The view key streams to NFPT in-memory only — nothing is persisted to our DB. Body: { chain, address, viewKey, birthdayHeight?, toHeight?, includeNotes? }.',
		mimeType: 'application/json',
		priceEnvKey: 'X402_PRIVATE_HISTORICAL_PRICE',
		discovery: Object.freeze({
			inputSchema: {
				type: 'object',
				required: ['chain', 'viewKey'],
				properties: {
					chain: { type: 'string', enum: ['monero', 'zcash'] },
					address: { type: 'string', description: 'Required for Monero; ignored for Zcash UFVK scans.' },
					viewKey: { type: 'string' },
					birthdayHeight: { type: 'integer' },
					toHeight: { type: 'integer' },
					includeNotes: { type: 'boolean' }
				}
			},
			input: {
				chain: 'zcash',
				viewKey: '<your-ufvk>',
				birthdayHeight: 2400000
			},
			output: {
				example: {
					chain: 'zcash',
					birthdayHeight: 2400000,
					scanned_at_ms: 1765532000000,
					elapsed_ms: 8421,
					view_key_handling: 'streamed to NFPT in memory only; not persisted to gateway DB or logs'
				},
				schema: {
					type: 'object',
					properties: {
						chain: { type: 'string' },
						address: { type: 'string' },
						birthdayHeight: { type: 'integer' },
						toHeight: { type: 'integer' },
						scanned_at_ms: { type: 'integer' },
						elapsed_ms: { type: 'integer' },
						view_key_handling: { type: 'string' }
					},
					additionalProperties: true
				}
			}
		})
	}),
	// POST /v1/private/derive-viewkey is intentionally FREE — it's
	// rate-limited per-IP at the handler level. Excluded from
	// GATEWAY_PREMIUM_ROUTES so x402 doesn't try to gate it.

	// === Privacy-chain atomic facts (Monero/Zcash) ===
	// Output property names mirror the queries-q-chain.js handlers
	// verbatim (snake_case) — indexers compare these against real
	// responses, so do not "tidy" them into camelCase.
	qFact('/v1/q/xmr/height',     'Single-fact: current Monero chain height + sync status. Sourced from a live operator-run monerod node.', {
		outputProps: { as_of_ms: { type: 'integer' }, chain: { type: 'string' }, height: { type: 'integer' }, synchronized: { type: 'boolean' }, behind_blocks: { type: 'integer' }, top_block_hash: { type: 'string' } },
		outputExample: { as_of_ms: 1765532000000, chain: 'monero', height: 3686932, synchronized: true, behind_blocks: 0, top_block_hash: '<block-hash>' }
	}),
	qFact('/v1/q/xmr/mempool',    'Single-fact: number of pending transactions in the Monero mempool right now.', {
		outputProps: { as_of_ms: { type: 'integer' }, chain: { type: 'string' }, count: { type: 'integer' } },
		outputExample: { as_of_ms: 1765532000000, chain: 'monero', count: 17 }
	}),
	qFact('/v1/q/xmr/fee',        'Single-fact: recommended Monero per-byte fee in piconero (also exposed per-kB for convenience).', {
		outputProps: { as_of_ms: { type: 'integer' }, chain: { type: 'string' }, fee_per_byte_piconero: { type: 'number' }, fee_per_kb_piconero: { type: 'number' } },
		outputExample: { as_of_ms: 1765532000000, chain: 'monero', fee_per_byte_piconero: 20000, fee_per_kb_piconero: 20480000 }
	}),
	qFact('/v1/q/xmr/last-block', 'Single-fact: timestamp + age of the most recent Monero block, plus hash, difficulty, and size.', {
		outputProps: { as_of_ms: { type: 'integer' }, chain: { type: 'string' }, height: { type: 'integer' }, hash: { type: 'string' }, timestamp_ms: { type: 'integer' }, age_s: { type: 'integer' }, difficulty: { type: 'number' }, size_bytes: { type: 'integer' } },
		outputExample: { as_of_ms: 1765532000000, chain: 'monero', height: 3686932, hash: '<block-hash>', timestamp_ms: 1765531900000, age_s: 100, difficulty: 511000000000, size_bytes: 117000 }
	}),
	qFact('/v1/q/zec/height',     'Single-fact: current Zcash chain height + verification progress + best block hash. Sourced from a live operator-run zebra node.', {
		outputProps: { as_of_ms: { type: 'integer' }, chain: { type: 'string' }, height: { type: 'integer' }, synchronized: { type: 'boolean' }, verification_progress: { type: 'number' }, best_block_hash: { type: 'string' } },
		outputExample: { as_of_ms: 1765532000000, chain: 'zcash', height: 3171000, synchronized: true, verification_progress: 0.9999, best_block_hash: '<block-hash>' }
	}),
	qFact('/v1/q/zec/mempool',    'Single-fact: Zcash mempool count + bytes.', {
		outputProps: { as_of_ms: { type: 'integer' }, chain: { type: 'string' }, count: { type: 'integer' }, bytes: { type: 'integer' } },
		outputExample: { as_of_ms: 1765532000000, chain: 'zcash', count: 3, bytes: 4096 }
	}),
	qFact('/v1/q/zec/last-block', 'Single-fact: timestamp + age of the most recent Zcash block, plus hash, difficulty, and size.', {
		outputProps: { as_of_ms: { type: 'integer' }, chain: { type: 'string' }, height: { type: 'integer' }, hash: { type: 'string' }, timestamp_ms: { type: 'integer' }, age_s: { type: 'integer' }, difficulty: { type: 'number' }, size_bytes: { type: 'integer' } },
		outputExample: { as_of_ms: 1765532000000, chain: 'zcash', height: 3171000, hash: '<block-hash>', timestamp_ms: 1765531925000, age_s: 75, difficulty: 280000000, size_bytes: 24000 }
	})
]);

export default GATEWAY_PREMIUM_ROUTES;
