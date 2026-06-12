// Production wiring for make-payment.js: loads the `.wult` share from disk,
// initialises the orchard-frost WASM engine in Node, derives the vault's
// UFVK/address, and exposes the kit's headless co-signed send pipeline.
//
// Kept separate from the service so tests exercise make-payment.js with
// plain fakes and never touch WASM, the filesystem, or the network.

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
	unwrapVaultShare,
	toOrchardBundle,
	deriveOrchardAddressFromBundle,
	resolveCosignConfig,
	createWalletScannerClient,
	runHeadlessCosignSend
} from '@winbit32/wallet-kit';

/**
 * Load + initialise the orchard-frost WASM (wasm-bindgen `--target web`
 * build) from a directory on disk. The glue is an ES module whose location
 * is config-driven, so a static import is impossible — this is the one
 * sanctioned dynamic import in the gateway.
 */
export async function loadOrchardFrostWasmNode(wasmDir) {
	if (!wasmDir) {
		throw new Error('MAKE_PAYMENT_WASM_DIR is not set (directory with orchard_frost_wasm.js + _bg.wasm).');
	}
	const glueUrl = pathToFileURL(path.join(wasmDir, 'orchard_frost_wasm.js')).href;
	const glue = await import(glueUrl);
	const bytes = await fs.readFile(path.join(wasmDir, 'orchard_frost_wasm_bg.wasm'));
	await glue.default({ module_or_path: bytes });
	return glue;
}

/** Build the injected deps for {@link createMakePaymentService}. */
export function buildMakePaymentDeps(config) {
	return {
		async prepareWallet() {
			const content = await fs.readFile(config.makePaymentWultPath, 'utf8');
			const share = await unwrapVaultShare(content, config.makePaymentWultPassword || undefined);
			if (!share.orchardFrost) {
				throw new Error('This .wult share carries no Orchard FROST bundle — co-signed ZEC sends need one.');
			}
			const bundle = toOrchardBundle(share.orchardFrost);
			const wasm = await loadOrchardFrostWasmNode(config.makePaymentWasmDir);
			const addr = deriveOrchardAddressFromBundle(wasm, bundle);
			if (!addr) {
				throw new Error('Could not derive the vault address from this FROST share (incompatible WASM build?).');
			}

			const nfptBase = String(config.nfptBaseUrl || '').replace(/\/+$/, '');
			const cosignConfig = resolveCosignConfig({
				pcztApiBaseUrl: config.makePaymentPcztApiBase || `${nfptBase}/api/pczt`,
				relayBaseUrl: config.makePaymentRelayUrl,
				network: config.makePaymentNetwork === 'test' ? 'test' : 'main',
				fetchImpl: globalThis.fetch
			});
			const scanner = createWalletScannerClient({
				baseUrl: config.makePaymentScannerBase || `${nfptBase}/api`,
				apiKey: config.nfptApiKey || undefined
			});

			return {
				bundle,
				wasm,
				cosignConfig,
				scanner,
				ufvk: addr.ufvk,
				unifiedAddress: addr.unifiedAddress,
				minSigners: Number(bundle.minSigners ?? 2),
				maxSigners: Number(bundle.maxSigners ?? 2)
			};
		},

		runSend: (params) => runHeadlessCosignSend(params)
	};
}

export default buildMakePaymentDeps;
