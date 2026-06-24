// Unit tests for environment-driven config parsing. Focused on the
// NOTICE_BOARDS JSON-array parser, which must be lenient: a malformed
// value falls back rather than throwing, because the gateway it configures
// also serves payment routes and must not fail to boot over a boards typo.

import { describe, test, expect } from '@jest/globals';
import { buildConfig } from '../src/config.js';

describe('buildConfig — NOTICE_BOARDS', () => {
	test('valid JSON array → parsed boards (order preserved)', () => {
		const cfg = buildConfig({
			NOTICE_BOARDS: '[{"id":"agents","title":"Agents","description":"x"},{"id":"market","title":"Marketplace"}]'
		});
		expect(Array.isArray(cfg.noticeBoards)).toBe(true);
		expect(cfg.noticeBoards.map((b) => b.id)).toEqual(['agents', 'market']);
		expect(cfg.noticeBoards[0].description).toBe('x');
	});

	test('unset → null (host/standalone falls back to the default board)', () => {
		expect(buildConfig({}).noticeBoards).toBeNull();
	});

	test('empty string → null', () => {
		expect(buildConfig({ NOTICE_BOARDS: '' }).noticeBoards).toBeNull();
	});

	test('malformed JSON → null (must not crash a payments gateway at boot)', () => {
		expect(buildConfig({ NOTICE_BOARDS: '[{"id":"oops" ' }).noticeBoards).toBeNull();
	});

	test('valid JSON but not an array → null', () => {
		expect(buildConfig({ NOTICE_BOARDS: '{"id":"general"}' }).noticeBoards).toBeNull();
	});

	test('config object stays frozen', () => {
		const cfg = buildConfig({ NOTICE_BOARDS: '[{"id":"a","title":"A"}]' });
		expect(Object.isFrozen(cfg)).toBe(true);
	});
});
