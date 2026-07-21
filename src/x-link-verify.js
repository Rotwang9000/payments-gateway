// X (Twitter) self-attestation — proves a fundraiser controls a public X
// account, without any API key: X's public oEmbed endpoint returns a
// tweet's rendered HTML + author for any public tweet URL, no auth needed.
//
// This is NOT identity verification and NOT vetting — a fundraiser could
// still be lying about who they are. It proves one thing only: whoever runs
// this campaign page can also post to that X account. That gives donors a
// second, independently-checkable surface (the account's history, follower
// count, other posts) and gives the fundraiser a public reputation on the
// line if the campaign turns out to be bad. Ziving still does not vouch for
// anyone — see /terms.

const OEMBED_URL = 'https://publish.twitter.com/oembed';
const TWEET_URL_RE = /^https:\/\/(?:twitter\.com|x\.com)\/([A-Za-z0-9_]{1,15})\/status\/\d+/u;

/** True if `url` looks like a real tweet permalink (not a profile/search/etc URL). */
export function isTweetUrl(url) {
	return typeof url === 'string' && TWEET_URL_RE.test(url.trim());
}

function stripTags(html) {
	return String(html ?? '').replace(/<[^>]*>/gu, ' ');
}

/**
 * Fetch the tweet's oEmbed data and confirm `code` appears in its text.
 * Returns { ok: true, handle } or { ok: false, reason }.
 *
 * `fetchImpl` is injectable for tests (defaults to globalThis.fetch), same
 * pattern as viewkey-watch's crypto-price oracle.
 */
export async function verifyTweetHasCode(tweetUrl, code, {
	fetchImpl = globalThis.fetch,
	timeoutMs = 6_000
} = {}) {
	if (!isTweetUrl(tweetUrl)) return { ok: false, reason: 'not_a_tweet_url' };
	const needle = String(code ?? '').trim().toLowerCase();
	if (needle.length === 0) return { ok: false, reason: 'no_code' };

	const ac = new AbortController();
	const t = setTimeout(() => ac.abort(new Error('x-link-verify: request timed out')), timeoutMs);
	let res;
	try {
		const full = `${OEMBED_URL}?url=${encodeURIComponent(tweetUrl)}&omit_script=1`;
		res = await fetchImpl(full, { signal: ac.signal, headers: { accept: 'application/json' } });
	} catch (err) {
		return { ok: false, reason: 'fetch_failed', detail: err?.message ?? String(err) };
	} finally {
		clearTimeout(t);
	}
	if (!res.ok) {
		return { ok: false, reason: res.status === 404 ? 'tweet_not_found' : 'oembed_error' };
	}
	let body;
	try { body = await res.json(); }
	catch { return { ok: false, reason: 'bad_oembed_response' }; }

	const text = stripTags(body?.html).toLowerCase();
	if (!text.includes(needle)) return { ok: false, reason: 'code_not_found_in_tweet' };

	const authorUrl = typeof body?.author_url === 'string' ? body.author_url : '';
	const handle = authorUrl.split('/').filter(Boolean).pop();
	if (!handle) return { ok: false, reason: 'no_author' };

	return { ok: true, handle };
}
