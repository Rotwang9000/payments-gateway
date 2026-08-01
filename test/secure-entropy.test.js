import { describe, it, expect } from '@jest/globals';
import { validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

import {
	secureRandomBytes,
	assertIndependentDraws,
	checkRngHealth,
	generateEntropyBytes,
	describeEntropySources
} from '../src/secure-entropy.js';
import { generatePhrase } from '../src/utility-tools.js';

describe('secure-entropy', () => {
	it('reports a healthy CSPRNG on a normal Node process', () => {
		const health = checkRngHealth(true);
		expect(health.ok).toBe(true);
		expect(health.drawsDiffer).toBe(true);
		expect(health.distinctByteValues).toBeGreaterThanOrEqual(200);
	});

	it('returns the requested number of bytes', () => {
		for (const n of [16, 20, 24, 28, 32]) {
			expect(generateEntropyBytes(n)).toHaveLength(n);
		}
	});

	it('does not repeat across calls, with or without extra entropy', () => {
		const seen = new Set();
		for (let i = 0; i < 200; i++) seen.add(generateEntropyBytes(32).toString('hex'));
		// Constant attacker-supplied entropy must not fix the output: the
		// CSPRNG draws bracket it inside the HKDF input.
		for (let i = 0; i < 200; i++) seen.add(generateEntropyBytes(32, 'same every time').toString('hex'));
		expect(seen.size).toBe(400);
	});

	it('rejects nonsense lengths', () => {
		expect(() => secureRandomBytes(0)).toThrow(TypeError);
		expect(() => secureRandomBytes(-1)).toThrow(TypeError);
	});

	it('describes its construction for agents', () => {
		const d = describeEntropySources();
		expect(d.csprng).toMatch(/randomBytes/);
		expect(d.construction).toMatch(/HKDF-SHA512/);
		expect(d.health.ok).toBe(true);
	});
});

describe('generatePhrase', () => {
	it('generates valid mnemonics of every supported length', () => {
		for (const [wordCount, bits] of [[12, 128], [15, 160], [18, 192], [21, 224], [24, 256]]) {
			const out = generatePhrase(wordCount);
			expect(out.phrase.split(' ')).toHaveLength(wordCount);
			expect(validateMnemonic(out.phrase, wordlist)).toBe(true);
			expect(out.entropyBits).toBe(bits);
			expect(out.extraEntropyUsed).toBe(false);
		}
	});

	it('mixes in caller-supplied entropy and says so', () => {
		const out = generatePhrase(12, '4 2 6 1 3 5 5 2 1 6');
		expect(validateMnemonic(out.phrase, wordlist)).toBe(true);
		expect(out.extraEntropyUsed).toBe(true);
	});

	it('reports the live self-test alongside the phrase', () => {
		const out = generatePhrase(12);
		expect(out.entropySources.health.ok).toBe(true);
	});

	it('never repeats a phrase', () => {
		const seen = new Set();
		for (let i = 0; i < 300; i++) seen.add(generatePhrase(12).phrase);
		expect(seen.size).toBe(300);
	});

	it('still rejects an unsupported word count', () => {
		expect(() => generatePhrase(13)).toThrow(/wordCount must be one of/);
	});
});

describe('liveness at generation time', () => {
	it('refuses when the two draws a generation uses are identical', () => {
		// The boot-time health probe is cached, so a generator that
		// degrades afterwards must still be caught by the generation path.
		const stuck = Buffer.alloc(64, 7);
		expect(() => assertIndependentDraws(stuck, Buffer.from(stuck))).toThrow(/stuck/i);
	});

	it('passes two genuinely independent draws', () => {
		expect(() => assertIndependentDraws(secureRandomBytes(64), secureRandomBytes(64))).not.toThrow();
	});
});
