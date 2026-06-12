// Tests for the SecTools utility functions + their MCP tool family.
// Everything is local/offline, so no fakes are needed beyond the server stub.

import { describe, it, expect } from '@jest/globals';
import {
	validatePhrase,
	findChecksumWords,
	generatePhrase,
	splitSecretHex,
	combineSecretShares
} from '../src/utility-tools.js';
import { registerUtilityMcpTools } from '../src/mcp-tools.js';

// Classic BIP-39 test vector (entropy 0x00…00).
const ABANDON_12 = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const makeFakeMcpServer = () => {
	const tools = new Map();
	return {
		tools,
		registerTool: (name, meta, handler) => tools.set(name, { meta, handler })
	};
};

const parseContent = (result) => JSON.parse(result.content[0].text);

describe('validatePhrase', () => {
	it('accepts a known-good mnemonic (case/whitespace tolerant)', () => {
		const result = validatePhrase(`  ${ABANDON_12.toUpperCase()}  `);
		expect(result).toMatchObject({ valid: true, wordCount: 12, lengthValid: true, invalidWords: [] });
	});

	it('rejects a bad checksum without throwing', () => {
		const badChecksum = ABANDON_12.replace(/about$/, 'abandon');
		expect(validatePhrase(badChecksum)).toMatchObject({ valid: false, wordCount: 12, lengthValid: true, invalidWords: [] });
	});

	it('reports non-wordlist words and bad lengths', () => {
		const result = validatePhrase('abandon zzzz abandon');
		expect(result.valid).toBe(false);
		expect(result.invalidWords).toEqual(['zzzz']);
		expect(result.lengthValid).toBe(false);
		expect(result.expectedLengths).toEqual([12, 15, 18, 21, 24]);
	});
});

describe('findChecksumWords', () => {
	it('finds the real checksum word among the candidates for 11x abandon', () => {
		const { candidates, position } = findChecksumWords(ABANDON_12.split(' ').slice(0, 11).join(' '));
		expect(position).toBe(12);
		expect(candidates).toContain('about');
		// Final word = 7 free entropy bits + 4 forced checksum bits → 2^7 candidates.
		expect(candidates).toHaveLength(128);
	});

	it('rejects wrong word counts and unknown words', () => {
		expect(() => findChecksumWords('abandon abandon')).toThrow(/expected 11\/14\/17\/20\/23 words/);
		expect(() => findChecksumWords(ABANDON_12.split(' ').slice(0, 10).join(' ') + ' zzzz')).toThrow(/Not BIP-39 words: zzzz/);
	});
});

describe('generatePhrase', () => {
	it('generates valid phrases of each supported length', () => {
		for (const wordCount of [12, 15, 18, 21, 24]) {
			const { phrase } = generatePhrase(wordCount);
			expect(phrase.split(' ')).toHaveLength(wordCount);
			expect(validatePhrase(phrase).valid).toBe(true);
		}
	});

	it('rejects unsupported lengths', () => {
		expect(() => generatePhrase(13)).toThrow(/wordCount must be one of/);
	});
});

describe('shamir split/combine', () => {
	const SECRET = 'deadbeefcafebabe0123456789abcdef';

	it('round-trips with exactly the threshold of shares', () => {
		const { shares } = splitSecretHex(SECRET, 5, 3);
		expect(shares).toHaveLength(5);
		const { secretHex } = combineSecretShares(shares.slice(1, 4));
		expect(secretHex).toBe(SECRET);
	});

	it('validates inputs', () => {
		expect(() => splitSecretHex('xyz', 3, 2)).toThrow(/even-length hex/);
		expect(() => splitSecretHex(SECRET, 2, 3)).toThrow(/threshold <= shares/);
		expect(() => combineSecretShares(['aa'])).toThrow(/at least two/);
		expect(() => combineSecretShares(['aa', 'zz'])).toThrow(/hex strings/);
	});
});

describe('registerUtilityMcpTools', () => {
	it('registers the family and round-trips through MCP handlers', async () => {
		const server = makeFakeMcpServer();
		const { names } = registerUtilityMcpTools(server, { toolPrefix: 'wb32' });
		expect(names).toEqual([
			'wb32_phrase_validate', 'wb32_phrase_complete', 'wb32_phrase_generate',
			'wb32_shamir_split', 'wb32_shamir_combine'
		]);

		const validated = parseContent(await server.tools.get('wb32_phrase_validate').handler({ phrase: ABANDON_12 }));
		expect(validated.valid).toBe(true);

		const split = parseContent(await server.tools.get('wb32_shamir_split').handler({ secretHex: 'aabbcc', shares: 3, threshold: 2 }));
		const combined = parseContent(await server.tools.get('wb32_shamir_combine').handler({ shares: split.shares.slice(0, 2) }));
		expect(combined.secretHex).toBe('aabbcc');
	});

	it('returns error envelopes instead of throwing', async () => {
		const server = makeFakeMcpServer();
		registerUtilityMcpTools(server, {});
		const res = parseContent(await server.tools.get('gateway_phrase_complete').handler({ partialPhrase: 'one two' }));
		expect(res.error.code).toBe('utility_tool_failed');
	});
});
