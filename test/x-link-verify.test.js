// Unit tests for the X (Twitter) oEmbed self-attestation check — no network,
// fetchImpl is stubbed.

import { describe, test, expect } from '@jest/globals';

import { isTweetUrl, verifyTweetHasCode } from '../src/x-link-verify.js';

const TWEET_URL = 'https://x.com/alice/status/1234567890123456789';

function oembedResponse(html, authorUrl = 'https://x.com/alice') {
	return {
		ok: true,
		status: 200,
		json: async () => ({ html, author_name: 'Alice', author_url: authorUrl })
	};
}

describe('isTweetUrl', () => {
	test('accepts twitter.com and x.com status permalinks', () => {
		expect(isTweetUrl('https://x.com/alice/status/123')).toBe(true);
		expect(isTweetUrl('https://twitter.com/alice/status/123')).toBe(true);
	});
	test('rejects profile URLs, other hosts, and junk', () => {
		expect(isTweetUrl('https://x.com/alice')).toBe(false);
		expect(isTweetUrl('https://evil.example/status/123')).toBe(false);
		expect(isTweetUrl('not a url')).toBe(false);
		expect(isTweetUrl(undefined)).toBe(false);
	});
});

describe('verifyTweetHasCode', () => {
	test('rejects non-tweet URLs before making a request', async () => {
		const fetchImpl = async () => { throw new Error('should not be called'); };
		const out = await verifyTweetHasCode('https://x.com/alice', 'ziving-abc12345', { fetchImpl });
		expect(out).toEqual({ ok: false, reason: 'not_a_tweet_url' });
	});

	test('succeeds when the code appears in the tweet html and extracts the handle', async () => {
		const fetchImpl = async () => oembedResponse('<blockquote>Proving my page: ziving-abc12345</blockquote>');
		const out = await verifyTweetHasCode(TWEET_URL, 'ziving-abc12345', { fetchImpl });
		expect(out).toEqual({ ok: true, handle: 'alice' });
	});

	test('is case-insensitive on the code', async () => {
		const fetchImpl = async () => oembedResponse('<blockquote>ZIVING-ABC12345</blockquote>');
		const out = await verifyTweetHasCode(TWEET_URL, 'ziving-abc12345', { fetchImpl });
		expect(out.ok).toBe(true);
	});

	test('fails when the code is missing from the tweet', async () => {
		const fetchImpl = async () => oembedResponse('<blockquote>unrelated tweet</blockquote>');
		const out = await verifyTweetHasCode(TWEET_URL, 'ziving-abc12345', { fetchImpl });
		expect(out).toEqual({ ok: false, reason: 'code_not_found_in_tweet' });
	});

	test('fails on 404 (deleted/private tweet)', async () => {
		const fetchImpl = async () => ({ ok: false, status: 404 });
		const out = await verifyTweetHasCode(TWEET_URL, 'ziving-abc12345', { fetchImpl });
		expect(out).toEqual({ ok: false, reason: 'tweet_not_found' });
	});

	test('fails cleanly when the fetch throws (timeout, network error)', async () => {
		const fetchImpl = async () => { throw new Error('boom'); };
		const out = await verifyTweetHasCode(TWEET_URL, 'ziving-abc12345', { fetchImpl });
		expect(out.ok).toBe(false);
		expect(out.reason).toBe('fetch_failed');
	});

	test('rejects an empty code', async () => {
		const fetchImpl = async () => { throw new Error('should not be called'); };
		const out = await verifyTweetHasCode(TWEET_URL, '', { fetchImpl });
		expect(out).toEqual({ ok: false, reason: 'no_code' });
	});
});
