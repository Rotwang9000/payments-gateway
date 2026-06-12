// SecTools-style key-hygiene utilities, ported from the Winbit32 desktop
// (src/components/apps/sectools/) for the MCP utility tool family.
//
// Everything here is local and offline: inputs are processed in-memory and
// returned; nothing is stored, logged or sent anywhere. These tools handle
// SECRET MATERIAL IN FLIGHT (phrases, key hex, Shamir shares) — operators
// who care should run this server themselves rather than trust a hosted one.

import { split as shamirSplit, combine as shamirCombine } from 'shamirs-secret-sharing';
import { generateMnemonic, validateMnemonic } from '@scure/bip39';
import { wordlist as englishWordlist } from '@scure/bip39/wordlists/english.js';

const VALID_PHRASE_LENGTHS = [12, 15, 18, 21, 24];
const PHRASE_STRENGTH_BY_LENGTH = { 12: 128, 15: 160, 18: 192, 21: 224, 24: 256 };
const MAX_SHAMIR_SHARES = 255;
const HEX_RE = /^[0-9a-fA-F]+$/;

const normaliseWords = (phrase) =>
	String(phrase || '').trim().toLowerCase().split(/\s+/).filter(Boolean);

function hexToBytes(hex) {
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < hex.length; i += 2) {
		bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
	}
	return bytes;
}

function bytesToHex(bytes) {
	return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Validate a BIP-39 mnemonic: length, word membership and checksum.
 * Never throws — agents need the diagnosis, not an exception.
 */
export function validatePhrase(phrase) {
	const words = normaliseWords(phrase);
	const invalidWords = [...new Set(words.filter((w) => !englishWordlist.includes(w)))];
	const lengthValid = VALID_PHRASE_LENGTHS.includes(words.length);
	const checksumValid = lengthValid && invalidWords.length === 0
		? validateMnemonic(words.join(' '), englishWordlist)
		: false;
	return {
		valid: checksumValid,
		wordCount: words.length,
		lengthValid,
		invalidWords,
		...(lengthValid || words.length === 0 ? {} : { expectedLengths: VALID_PHRASE_LENGTHS })
	};
}

/**
 * Given a phrase missing its final (checksum) word — 11, 14, 17, 20 or 23
 * words — return every final word that yields a valid mnemonic. There are
 * always several: the last word carries some free entropy bits plus the
 * forced checksum (128 candidates for 12-word phrases, 8 for 24-word).
 */
export function findChecksumWords(partialPhrase) {
	const words = normaliseWords(partialPhrase);
	if (!VALID_PHRASE_LENGTHS.includes(words.length + 1)) {
		throw new Error(`Provide all words except the last; expected ${VALID_PHRASE_LENGTHS.map((n) => n - 1).join('/')} words, got ${words.length}`);
	}
	const unknown = words.filter((w) => !englishWordlist.includes(w));
	if (unknown.length > 0) {
		throw new Error(`Not BIP-39 words: ${unknown.join(', ')}`);
	}
	const candidates = [];
	for (const candidate of englishWordlist) {
		if (validateMnemonic(words.concat(candidate).join(' '), englishWordlist)) {
			candidates.push(candidate);
		}
	}
	// Assumption check: a well-formed prefix always has ≥1 completion.
	if (candidates.length === 0) {
		throw new Error('No valid checksum word found — input words are inconsistent');
	}
	return { candidates, position: words.length + 1 };
}

/** Generate a fresh BIP-39 mnemonic of the requested length (default 12). */
export function generatePhrase(wordCount = 12) {
	const strength = PHRASE_STRENGTH_BY_LENGTH[wordCount];
	if (!strength) {
		throw new Error(`wordCount must be one of ${VALID_PHRASE_LENGTHS.join(', ')}`);
	}
	return { phrase: generateMnemonic(englishWordlist, strength), wordCount };
}

/**
 * Shamir-split a hex secret into `shares` parts, any `threshold` of which
 * reconstruct it. Ported from SecTools Split.
 */
export function splitSecretHex(secretHex, shares, threshold) {
	const hex = String(secretHex || '').trim();
	if (!HEX_RE.test(hex) || hex.length % 2 !== 0) {
		throw new Error('secretHex must be an even-length hex string');
	}
	if (!Number.isInteger(shares) || !Number.isInteger(threshold)) {
		throw new Error('shares and threshold must be integers');
	}
	if (threshold < 2 || shares < threshold || shares > MAX_SHAMIR_SHARES) {
		throw new Error(`Need 2 <= threshold <= shares <= ${MAX_SHAMIR_SHARES}`);
	}
	const parts = shamirSplit(Buffer.from(hexToBytes(hex)), { shares, threshold });
	return { shares: parts.map((p) => bytesToHex(p)), threshold, shareCount: shares };
}

/** Reconstruct a Shamir-split hex secret from >= threshold shares. */
export function combineSecretShares(sharesHex) {
	if (!Array.isArray(sharesHex) || sharesHex.length < 2) {
		throw new Error('Provide at least two hex shares');
	}
	const bad = sharesHex.filter((s) => !HEX_RE.test(String(s).trim()) || String(s).trim().length % 2 !== 0);
	if (bad.length > 0) {
		throw new Error('All shares must be even-length hex strings');
	}
	const buffers = sharesHex.map((s) => Buffer.from(hexToBytes(String(s).trim())));
	const combined = shamirCombine(buffers);
	return { secretHex: bytesToHex(combined) };
}
