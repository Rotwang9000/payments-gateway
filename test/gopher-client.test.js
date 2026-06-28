// Gopher-over-HTTPS browser core — the shared client behind every front-end
// (winbit32 retro tree + Seneschal plain web). Pure logic; fetch is injectable.

import { describe, it, expect, jest } from '@jest/globals';
import {
	parseGopherMenu,
	getTypeInfo,
	looksLikeHtml,
	buildHttpUrl,
	locationFromUrl,
	isGopherUrl,
	buildSearchSelector,
	fetchGopherText,
	buildHomeMenu,
	createGopherBrowser,
	WELL_KNOWN_SELECTOR,
	DEFAULT_GOPHER_PORT,
} from '../src/gopher-client.js';

// A trimmed real-world Seneschal root menu (compact form: no host/port).
const SENESCHAL_ROOT = [
	'iAgent/MCP services \u2014 terse index for machines (Gopher-over-HTTPS).\t',
	'iLines are <type><label>TAB<selector>. Type 1 = drill in, 0 = read, h = URL.\t',
	'i\t',
	'1winbit32 \u2014 agent-facing private payments (FROST co-sign)\t/.well-known/agent/winbit32',
	'1MCP registry \u2014 live mirror of the official registry\t/.well-known/agent/registry',
	'i\t',
	'0about \u2014 what this directory is and why\t/.well-known/agent/about',
	'hHomepage\tURL:https://seneschal.space',
	'.',
	'1ignored after terminator\t/nope',
].join('\n');

describe('getTypeInfo', () => {
	it('maps canonical types', () => {
		expect(getTypeInfo('1').kind).toBe('menu');
		expect(getTypeInfo('0').kind).toBe('text');
		expect(getTypeInfo('h').kind).toBe('link');
		expect(getTypeInfo('i').kind).toBe('info');
		expect(getTypeInfo('7').kind).toBe('search');
	});

	it('info and error lines are not selectable', () => {
		expect(getTypeInfo('i').selectable).toBe(false);
		expect(getTypeInfo('3').selectable).toBe(false);
	});

	it('unknown type is a safe placeholder', () => {
		const info = getTypeInfo('Z');
		expect(info.kind).toBe('unknown');
		expect(info.selectable).toBe(false);
	});
});

describe('parseGopherMenu', () => {
	it('parses types, inherits host, and stops at the terminator', () => {
		const items = parseGopherMenu(SENESCHAL_ROOT, 'seneschal.space');
		expect(items).toHaveLength(8);
		expect(items.some((i) => i.label === 'ignored after terminator')).toBe(false);

		const winbit32 = items.find((i) => i.label.startsWith('winbit32'));
		expect(winbit32.kind).toBe('menu');
		expect(winbit32.selector).toBe('/.well-known/agent/winbit32');
		expect(winbit32.host).toBe('seneschal.space');
		expect(winbit32.port).toBe(DEFAULT_GOPHER_PORT);
	});

	it('extracts the real URL from an h URL: link', () => {
		const items = parseGopherMenu(SENESCHAL_ROOT, 'seneschal.space');
		const link = items.find((i) => i.kind === 'link');
		expect(link.url).toBe('https://seneschal.space');
	});

	it('info spacer lines survive with an empty label', () => {
		const items = parseGopherMenu(SENESCHAL_ROOT, 'seneschal.space');
		const spacers = items.filter((i) => i.kind === 'info' && i.label === '');
		expect(spacers.length).toBe(2);
	});

	it('honours an explicit host + port (classic four-field form)', () => {
		const items = parseGopherMenu('1Bookmark\t/sel\texample.org\t70', 'fallback.host');
		expect(items[0].host).toBe('example.org');
		expect(items[0].port).toBe(70);
	});

	it('non-string input does not throw', () => {
		expect(parseGopherMenu(undefined)).toEqual([]);
	});
});

describe('looksLikeHtml', () => {
	it('detects SPA fallback HTML', () => {
		expect(looksLikeHtml('<!doctype html><html>...')).toBe(true);
		expect(looksLikeHtml('  <html lang="en">')).toBe(true);
	});
	it('passes a gopher menu through', () => {
		expect(looksLikeHtml('iHello\t')).toBe(false);
	});
});

describe('buildHttpUrl', () => {
	it('omits the default 443 port and ensures a leading slash', () => {
		expect(buildHttpUrl('seneschal.space', '/.well-known/agent.gopher')).toBe(
			'https://seneschal.space/.well-known/agent.gopher',
		);
		expect(buildHttpUrl('host', 'rel/path')).toBe('https://host/rel/path');
	});
	it('keeps a non-default port and query strings', () => {
		expect(buildHttpUrl('host', '/a?cursor=x', 8443)).toBe('https://host:8443/a?cursor=x');
	});
	it('throws without a host', () => {
		expect(() => buildHttpUrl('')).toThrow();
	});
});

describe('locationFromUrl', () => {
	it('splits host, selector and query', () => {
		expect(locationFromUrl('https://seneschal.space/.well-known/agent/registry?cursor=ab')).toEqual({
			host: 'seneschal.space',
			selector: '/.well-known/agent/registry?cursor=ab',
			port: DEFAULT_GOPHER_PORT,
		});
	});
});

describe('isGopherUrl', () => {
	it('recognises discovery cards', () => {
		expect(isGopherUrl('https://flashbank.net/.well-known/agent.gopher')).toBe(true);
		expect(isGopherUrl('https://x.tld/.well-known/agent/registry?cursor=1')).toBe(true);
	});
	it('rejects ordinary pages', () => {
		expect(isGopherUrl('https://github.com/FungeLLC/winbit32MCP')).toBe(false);
		expect(isGopherUrl('https://mcp.winbit32.com/mcp')).toBe(false);
	});
});

describe('buildSearchSelector', () => {
	it('appends an encoded query', () => {
		expect(buildSearchSelector('/search', 'a b')).toBe('/search?q=a%20b');
		expect(buildSearchSelector('/s?x=1', 'y')).toBe('/s?x=1&q=y');
	});
});

describe('buildHomeMenu', () => {
	it('renders bookmarks as type-1 drill-in lines that inherit selfHost', () => {
		const items = buildHomeMenu({
			selfHost: 'localhost:3000',
			bookmarks: [
				{ label: "winbit32 — this site's agent / MCP card", host: 'localhost:3000' },
				{ label: 'Seneschal', host: 'seneschal.space' },
			],
			links: [{ label: 'Docs', url: 'https://seneschal.space/gopher/' }],
		});
		const self = items.find((i) => i.label.includes('this site'));
		expect(self.kind).toBe('menu');
		expect(self.host).toBe('localhost:3000');
		expect(self.selector).toBe(WELL_KNOWN_SELECTOR);
		expect(items.some((i) => i.host === 'seneschal.space')).toBe(true);
		const link = items.find((i) => i.kind === 'link');
		expect(link.url).toBe('https://seneschal.space/gopher/');
	});

	it('returns an empty menu for no bookmarks/links', () => {
		expect(buildHomeMenu()).toEqual([]);
	});

	it('uses a custom selector when given (non-well-known bookmark)', () => {
		const items = buildHomeMenu({
			selfHost: 'h',
			bookmarks: [{ label: 'Sub', host: 'h', selector: '/.well-known/agent/actions' }],
		});
		expect(items[0].selector).toBe('/.well-known/agent/actions');
	});
});

describe('fetchGopherText', () => {
	it('returns parsed-ready text on a 200', async () => {
		const fetchImpl = jest.fn().mockResolvedValue({
			ok: true,
			status: 200,
			text: async () => 'iHello\t',
		});
		const res = await fetchGopherText('seneschal.space', WELL_KNOWN_SELECTOR, { fetchImpl });
		expect(res.ok).toBe(true);
		expect(res.text).toBe('iHello\t');
		expect(fetchImpl).toHaveBeenCalledWith(
			'https://seneschal.space/.well-known/agent.gopher',
			expect.objectContaining({ method: 'GET' }),
		);
	});

	it('flags an HTML (SPA fallback) body as not_gopher', async () => {
		const fetchImpl = jest.fn().mockResolvedValue({
			ok: true,
			status: 200,
			text: async () => '<!doctype html><html></html>',
		});
		const res = await fetchGopherText('winbit32.com', WELL_KNOWN_SELECTOR, { fetchImpl });
		expect(res.ok).toBe(false);
		expect(res.isHtml).toBe(true);
		expect(res.error).toBe('not_gopher');
	});

	it('reports HTTP errors without throwing', async () => {
		const fetchImpl = jest.fn().mockResolvedValue({
			ok: false,
			status: 404,
			text: async () => 'nope',
		});
		const res = await fetchGopherText('host', '/missing', { fetchImpl });
		expect(res.ok).toBe(false);
		expect(res.status).toBe(404);
		expect(res.error).toBe('HTTP 404');
	});

	it('maps an aborted fetch to a clean reason', async () => {
		const fetchImpl = jest.fn().mockRejectedValue(Object.assign(new Error('x'), { name: 'AbortError' }));
		const res = await fetchGopherText('host', '/x', { fetchImpl });
		expect(res.ok).toBe(false);
		expect(res.error).toBe('aborted');
	});

	it('returns no_fetch when no implementation is available', async () => {
		const original = global.fetch;
		global.fetch = undefined;
		try {
			const res = await fetchGopherText('host', '/x', { fetchImpl: null });
			expect(res.ok).toBe(false);
			expect(res.error).toBe('no_fetch');
		} finally {
			global.fetch = original;
		}
	});
});

describe('createGopherBrowser', () => {
	// A tiny fake gopher host: maps "<host><selector>" to a body.
	const PAGES = {
		'demo.site/.well-known/agent.gopher': [
			'iDemo card\t',
			'1Actions\t/.well-known/agent/actions',
			'0About\t/.well-known/agent/about',
			'7Search the catalogue\t/.well-known/agent/search',
			'hWebsite\tURL:https://demo.site',
			'.',
		].join('\n'),
		'demo.site/.well-known/agent/about': 'About Demo.\nLine two.\n',
		'demo.site/.well-known/agent/search?q=zec': '1Result A\t/r/a\n.\n',
	};
	const makeFetch = () => jest.fn(async (url) => {
		const { host, pathname, search } = new URL(url);
		const key = `${host}${pathname}${search}`;
		const body = PAGES[key];
		if (body === undefined) return { ok: false, status: 404, text: async () => 'nope' };
		return { ok: true, status: 200, text: async () => body };
	});

	const newBrowser = (fetchImpl) => createGopherBrowser({
		fetchImpl,
		selfHost: 'demo.site',
		bookmarks: [{ label: 'Demo — this site', host: 'demo.site' }],
		links: [{ label: 'Guide', url: 'https://seneschal.space/gopher/' }],
	});

	it('starts on a Home tree built from bookmarks', () => {
		const b = newBrowser(makeFetch());
		const s = b.getState();
		expect(s.kind).toBe('home');
		expect(s.items.some((i) => i.label.includes('this site'))).toBe(true);
		expect(b.canGoBack()).toBe(false);
	});

	it('drills into a menu item and records back-history', async () => {
		const fetchImpl = makeFetch();
		const b = newBrowser(fetchImpl);
		const home = b.getState();
		const selfBookmark = home.items.find((i) => i.kind === 'menu');
		await b.openItem(selfBookmark);
		const s = b.getState();
		expect(s.kind).toBe('menu');
		expect(s.items.find((i) => i.label === 'Actions').selector).toBe('/.well-known/agent/actions');
		expect(b.canGoBack()).toBe(true);
	});

	it('opens a text leaf as text, then back() restores the menu', async () => {
		const b = newBrowser(makeFetch());
		await b.openItem(b.getState().items.find((i) => i.kind === 'menu')); // -> root menu
		const aboutItem = b.getState().items.find((i) => i.kind === 'text');
		await b.openItem(aboutItem);
		expect(b.getState().kind).toBe('text');
		expect(b.getState().text).toContain('About Demo.');
		await b.back();
		expect(b.getState().kind).toBe('menu');
	});

	it('runs a type-7 search by appending ?q=', async () => {
		const fetchImpl = makeFetch();
		const b = newBrowser(fetchImpl);
		await b.openItem(b.getState().items.find((i) => i.kind === 'menu'));
		const searchRow = b.getState().items.find((i) => i.kind === 'search');
		await b.search(searchRow, 'zec');
		expect(fetchImpl).toHaveBeenCalledWith(
			'https://demo.site/.well-known/agent/search?q=zec',
			expect.objectContaining({ method: 'GET' }),
		);
		expect(b.getState().items.find((i) => i.label === 'Result A')).toBeTruthy();
	});

	it('leaves state unchanged for external (non-gopher) links', async () => {
		const b = newBrowser(makeFetch());
		await b.openItem(b.getState().items.find((i) => i.kind === 'menu'));
		const before = b.getState();
		const webLink = before.items.find((i) => i.kind === 'link' && !isGopherUrl(i.url));
		const after = await b.openItem(webLink);
		expect(after).toBe(before);
	});

	it('notifies subscribers and surfaces a loading flag', async () => {
		const b = newBrowser(makeFetch());
		const seen = [];
		b.subscribe((s) => seen.push(s.loading));
		await b.openItem(b.getState().items.find((i) => i.kind === 'menu'));
		expect(seen).toContain(true); // loading=true during the fetch
		expect(b.getState().loading).toBe(false);
	});

	it('home() resets to the tree and clears history', async () => {
		const b = newBrowser(makeFetch());
		await b.openItem(b.getState().items.find((i) => i.kind === 'menu'));
		b.home();
		expect(b.getState().kind).toBe('home');
		expect(b.canGoBack()).toBe(false);
	});

	it('records an error view without throwing on a 404', async () => {
		const b = newBrowser(makeFetch());
		await b.openLocation({ host: 'demo.site', selector: '/missing' }, false, 'Missing');
		expect(b.getState().kind).toBe('error');
		expect(b.getState().error).toBe('HTTP 404');
	});
});
