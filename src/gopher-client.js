/**
 * Gopher-over-HTTPS browser core — brand-neutral, framework-free.
 *
 * The single shared implementation of the "fetch + parse + navigate a
 * 1991-vintage Gopher menu (RFC 1436) served natively over HTTPS" client used
 * by every front-end in this ecosystem: the winbit32 desktop renders it as a
 * retro tree, the Seneschal site renders it as a plain web page. Only the view
 * differs — the protocol/browser logic lives here, once.
 *
 * This is the *client* counterpart to {@link module:gophermap} (the wire-format
 * build/parse primitive used by servers). It deliberately produces a richer,
 * presentation-ready item shape (kind/icon/selectable, host/port inheritance,
 * resolved `url`) than the minimal server round-trip parser, and adds the
 * fetch + URL-resolution helpers a browser needs. The canonical type codes and
 * `URL:` un-wrapping are reused from gophermap so there is one source of truth.
 *
 * A menu line is `<type><label>TAB<selector>[TAB<host>[TAB<port>]]`. In the
 * compact (HTTPS) form the host + port are dropped — TLS already supplies them —
 * so they are inherited from the request origin. The classic four-field form is
 * still accepted so synthetic "bookmark" menus can point at several hosts.
 *
 * Everything here is pure + side-effect free except {@link fetchGopherText},
 * which takes an injectable `fetchImpl` so it can be unit tested without a
 * network. There is intentionally no framework code in this file.
 *
 * @module gopher-client
 */

import { ItemType, linkHref } from './gophermap.js';

/** Default TLS port — omitted from built URLs when in effect. */
export const DEFAULT_GOPHER_PORT = 443;

/** Well-known discovery selector every site is expected to publish. */
export const WELL_KNOWN_SELECTOR = '/.well-known/agent.gopher';

/** Base path beneath which a site's drill-down sections live. */
export const AGENT_BASE = '/.well-known/agent';

/**
 * Gopher item type table (RFC 1436 canonical types plus a few common
 * extensions). `selectable` means "a user can act on this line"; info
 * (`i`) and error (`3`) lines are presentational only.
 *
 * Kept module-local (not exported) — callers read it through
 * {@link getTypeInfo} so there is a single source of truth. Canonical codes
 * come from gophermap's {@link ItemType}; the extra binary/media codes are
 * literals (gophermap only models the directory subset).
 */
const GOPHER_TYPES = {
	[ItemType.TEXT]: { kind: 'text', icon: '\u{1F4C4}', label: 'Text', selectable: true },
	[ItemType.MENU]: { kind: 'menu', icon: '\u{1F4C1}', label: 'Directory', selectable: true },
	[ItemType.SEARCH]: { kind: 'search', icon: '\u{1F50D}', label: 'Search', selectable: true },
	[ItemType.LINK]: { kind: 'link', icon: '\u{1F310}', label: 'Link', selectable: true },
	[ItemType.INFO]: { kind: 'info', icon: '', label: 'Info', selectable: false },
	[ItemType.ERROR]: { kind: 'error', icon: '\u26A0\uFE0F', label: 'Error', selectable: false },
	'8': { kind: 'telnet', icon: '\u{1F5A5}\uFE0F', label: 'Telnet', selectable: true },
	'9': { kind: 'binary', icon: '\u{1F4BE}', label: 'Binary', selectable: true },
	'g': { kind: 'image', icon: '\u{1F5BC}\uFE0F', label: 'GIF', selectable: true },
	'I': { kind: 'image', icon: '\u{1F5BC}\uFE0F', label: 'Image', selectable: true },
	's': { kind: 'sound', icon: '\u{1F50A}', label: 'Sound', selectable: true },
	'd': { kind: 'doc', icon: '\u{1F4C4}', label: 'Document', selectable: true },
};

const UNKNOWN_TYPE = { kind: 'unknown', icon: '\u2753', label: 'Item', selectable: false };

/**
 * Look up the display + behaviour metadata for a one-character Gopher
 * type code. Unknown types are returned as a non-selectable placeholder
 * so a weird menu never throws.
 * @param {string} type single character type code
 */
export function getTypeInfo(type) {
	return GOPHER_TYPES[type] || UNKNOWN_TYPE;
}

/**
 * True when a body that should have been a Gopher menu is actually an
 * HTML page — the classic SPA `try_files … index.html` fallback. Lets the
 * UI say "this host doesn't serve a discovery card" instead of trying to
 * parse `<!doctype html>` as menu lines.
 * @param {string} text
 */
export function looksLikeHtml(text) {
	if (typeof text !== 'string') return false;
	const head = text.slice(0, 256).trim().toLowerCase();
	return (
		head.startsWith('<!doctype html') ||
		head.startsWith('<html') ||
		head.startsWith('<head') ||
		head.startsWith('<?xml')
	);
}

/**
 * Parse a Gopher menu document into structured, presentation-ready items.
 *
 * @param {string} text raw menu body
 * @param {string} [currentHost] host to inherit when a line omits its own
 * @param {number} [currentPort] port to inherit when a line omits its own
 * @returns {Array<{type:string, kind:string, icon:string, label:string,
 *   selector:string, host:string, port:number, url:(string|null),
 *   selectable:boolean, raw:string}>}
 */
export function parseGopherMenu(text, currentHost = '', currentPort = DEFAULT_GOPHER_PORT) {
	console.assert(typeof text === 'string', 'parseGopherMenu: text must be a string');
	if (typeof text !== 'string') return [];

	const items = [];
	const lines = text.split(/\r?\n/);

	for (const raw of lines) {
		// RFC 1436: a line containing only "." terminates the menu.
		if (raw === '.') break;
		// Skip genuinely empty lines (info spacers arrive as "i\t…").
		if (raw === '') continue;

		const type = raw[0];
		const info = getTypeInfo(type);
		const rest = raw.slice(1);
		const parts = rest.split('\t');

		const label = parts[0] ?? '';
		const selector = parts[1] ?? '';
		const host = (parts[2] && parts[2].length > 0) ? parts[2] : currentHost;
		const port = parts[3] ? (Number(parts[3]) || currentPort) : currentPort;

		// URL: links carry the real target after the "URL:" prefix; reuse
		// gophermap.linkHref so the un-wrapping rule lives in one place.
		const url = info.kind === 'link' ? linkHref({ selector }) : null;

		items.push({
			type,
			kind: info.kind,
			icon: info.icon,
			label,
			selector,
			host,
			port,
			url,
			selectable: info.selectable,
			raw,
		});
	}

	return items;
}

/**
 * Build the HTTPS URL a selector resolves to on a given host.
 * @param {string} host e.g. "seneschal.space"
 * @param {string} [selector] absolute path, may include a query string
 * @param {number} [port]
 */
export function buildHttpUrl(host, selector = WELL_KNOWN_SELECTOR, port = DEFAULT_GOPHER_PORT) {
	console.assert(Boolean(host), 'buildHttpUrl: host is required');
	if (!host) throw new Error('buildHttpUrl: host is required');
	let path = selector || '/';
	if (!path.startsWith('/')) path = '/' + path;
	const portPart = port && Number(port) !== DEFAULT_GOPHER_PORT ? `:${port}` : '';
	return `https://${host}${portPart}${path}`;
}

/**
 * Split an absolute http(s) URL into a Gopher {host, selector, port}
 * location so an `h URL:` discovery link can be browsed as a directory.
 * @param {string} url
 */
export function locationFromUrl(url) {
	console.assert(typeof url === 'string' && url.length > 0, 'locationFromUrl: url required');
	const parsed = new URL(url);
	const port = parsed.port ? Number(parsed.port) : DEFAULT_GOPHER_PORT;
	return {
		host: parsed.hostname,
		selector: (parsed.pathname || '/') + (parsed.search || ''),
		port,
	};
}

/**
 * Heuristic: does this URL point at a Gopher-over-HTTPS discovery card
 * (so we can drill into it) rather than an ordinary web page (open in a
 * new tab)?
 * @param {string} url
 */
export function isGopherUrl(url) {
	if (typeof url !== 'string') return false;
	return /\.gopher(?:$|[?#])/i.test(url) || /\/\.well-known\/agent(?:[/.?#]|$)/i.test(url);
}

/**
 * Append a query to a type-7 search selector. Seneschal's HTTPS profile
 * documents "append a query to the selector"; we use a `?q=`/`&q=` query
 * string (the pragmatic HTTPS reading of RFC 1436's TAB-delimited query).
 * @param {string} selector
 * @param {string} query
 */
export function buildSearchSelector(selector, query) {
	const q = encodeURIComponent(query == null ? '' : String(query));
	const sep = selector.includes('?') ? '&' : '?';
	return `${selector}${sep}q=${q}`;
}

/**
 * Fetch a Gopher selector over HTTPS and return its raw body. Never
 * throws — network/abort/CORS failures resolve to `{ ok: false, … }` so
 * the UI can render a tidy error row. The caller decides whether to parse
 * the body as a menu (type 1 / home) or show it as text (type 0).
 *
 * @param {string} host
 * @param {string} [selector]
 * @param {{fetchImpl?:typeof fetch, signal?:AbortSignal, port?:number}} [opts]
 * @returns {Promise<{ok:boolean, status:(number|null), text:string,
 *   url:string, host:string, selector:string, error:(string|null),
 *   isHtml:boolean}>}
 */
export async function fetchGopherText(host, selector = WELL_KNOWN_SELECTOR, opts = {}) {
	const { fetchImpl, signal, port = DEFAULT_GOPHER_PORT } = opts;
	const doFetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
	const url = host ? buildHttpUrl(host, selector, port) : '';

	const base = { ok: false, status: null, text: '', url, host, selector, error: null, isHtml: false };

	if (!doFetch) return { ...base, error: 'no_fetch' };
	if (!host) return { ...base, error: 'no_host' };

	let res;
	try {
		res = await doFetch(url, {
			method: 'GET',
			signal,
			headers: { Accept: 'application/gopher, text/plain;q=0.9, */*;q=0.5' },
		});
	} catch (e) {
		const aborted = e && (e.name === 'AbortError' || e.code === 20);
		return { ...base, error: aborted ? 'aborted' : (e && e.message) || 'network_error' };
	}

	let text = '';
	try {
		text = await res.text();
	} catch (e) {
		return { ...base, status: res.status, error: 'read_error' };
	}

	if (!res.ok) {
		return { ...base, status: res.status, text, error: `HTTP ${res.status}` };
	}
	if (looksLikeHtml(text)) {
		return { ...base, status: res.status, text, isHtml: true, error: 'not_gopher' };
	}
	return { ok: true, status: res.status, text, url, host, selector, error: null, isHtml: false };
}

/**
 * Build a synthetic "Home" bookmark menu — the starting tree a client shows
 * before any network call. Brand-neutral: the caller supplies the directory of
 * sites (`bookmarks`) and external `links`, so winbit32 can lead with itself
 * and Seneschal can lead with itself from the same code.
 *
 * Returns a freshly parsed item array each call (nothing shared is exported).
 *
 * @param {object} opts
 * @param {string} [opts.selfHost] origin host used to inherit host/port on
 *   bookmark lines that omit their own (and as the parse fallback host)
 * @param {Array<{label:string, host:string, selector?:string}>} [opts.bookmarks]
 *   directory entries rendered as type-1 "drill in" lines
 * @param {Array<{label:string, url:string}>} [opts.links] external links
 *   rendered as type-h `URL:` lines below a spacer
 * @returns {ReturnType<typeof parseGopherMenu>}
 */
export function buildHomeMenu({ selfHost = '', bookmarks = [], links = [] } = {}) {
	const lines = [];
	for (const bm of bookmarks) {
		if (!bm || !bm.host) continue;
		const selector = bm.selector || WELL_KNOWN_SELECTOR;
		lines.push(`1${bm.label ?? bm.host}\t${selector}\t${bm.host}`);
	}
	if (links.length > 0) lines.push('i\t');
	for (const ln of links) {
		if (!ln || !ln.url) continue;
		lines.push(`h${ln.label ?? ln.url}\tURL:${ln.url}`);
	}
	return parseGopherMenu(lines.join('\n'), selfHost);
}

/**
 * @typedef {object} GopherLocation
 * @property {string} host
 * @property {string} selector
 * @property {number} [port]
 */

/**
 * @typedef {object} GopherViewState
 * @property {'home'|'menu'|'text'|'error'} kind
 * @property {string} title
 * @property {ReturnType<typeof parseGopherMenu>} items menu rows (empty for text)
 * @property {string} text raw body (text leaves / error detail)
 * @property {(GopherLocation|null)} location current location (null on home)
 * @property {(string|null)} error machine-readable error reason
 * @property {boolean} loading a fetch is in flight
 */

/**
 * Create a framework-agnostic Gopher "browser": the shared navigation brain
 * that fetches, parses, and walks the tree, keeping a back-history. Every
 * front-end binds the same controller to its own view — the winbit32 desktop
 * renders {@link getState} as a retro window, the Seneschal site renders it as
 * a plain web page. The view layer owns presentation and the two host-specific
 * concerns the core deliberately does NOT handle:
 *   - external (non-gopher) links — the UI opens them in a new tab;
 *   - payment "actions" — the UI hands these to its own payer (vault on
 *     winbit32, plaintext phrase box on Seneschal).
 *
 * Navigation methods are async and update state via {@link subscribe}; `back`
 * restores the previous snapshot without re-fetching.
 *
 * @param {object} opts
 * @param {typeof fetch} [opts.fetchImpl] injected fetch (defaults to global)
 * @param {string} [opts.selfHost] origin host for the Home tree
 * @param {Array<{label:string, host:string, selector?:string}>} [opts.bookmarks]
 * @param {Array<{label:string, url:string}>} [opts.links]
 */
export function createGopherBrowser({ fetchImpl, selfHost = '', bookmarks = [], links = [] } = {}) {
	const listeners = new Set();
	let history = [];
	/** @type {GopherViewState} */
	let state;

	const freshHome = () => ({
		kind: 'home',
		title: 'Home',
		items: buildHomeMenu({ selfHost, bookmarks, links }),
		text: '',
		location: null,
		error: null,
		loading: false,
	});

	function setState(next) {
		state = next;
		for (const fn of listeners) fn(state);
	}

	/** Subscribe to state changes; fires immediately with the current state. */
	function subscribe(fn) {
		listeners.add(fn);
		fn(state);
		return () => listeners.delete(fn);
	}

	function getState() { return state; }
	function canGoBack() { return history.length > 0; }

	// Fetch + parse a location as a menu (asText=false) or a text leaf
	// (asText=true). Records the prior (settled) snapshot for back().
	async function load(location, asText = false, title = '') {
		const prev = state;
		setState({ ...state, loading: true, error: null });
		const res = await fetchGopherText(location.host, location.selector, {
			fetchImpl,
			port: location.port,
		});
		history.push(prev);
		if (!res.ok) {
			setState({
				kind: 'error',
				title: title || 'Error',
				items: [],
				text: res.text || '',
				location,
				error: res.error || 'error',
				loading: false,
			});
		} else if (asText) {
			setState({
				kind: 'text',
				title: title || location.selector,
				items: [],
				text: res.text,
				location,
				error: null,
				loading: false,
			});
		} else {
			setState({
				kind: 'menu',
				title: title || location.selector,
				items: parseGopherMenu(res.text, location.host, location.port),
				text: '',
				location,
				error: null,
				loading: false,
			});
		}
		return state;
	}

	/** Reset to the Home bookmark tree and clear history. */
	function home() {
		history = [];
		setState(freshHome());
		return state;
	}

	/**
	 * Act on a parsed menu item. Drills into menus, gopher links and text
	 * leaves; returns the unchanged state for external links and search rows
	 * (the caller handles those — open a tab / prompt for a query).
	 */
	function openItem(item) {
		if (!item) return Promise.resolve(state);
		if (item.kind === 'menu') {
			return load({ host: item.host, selector: item.selector, port: item.port }, false, item.label);
		}
		if (item.kind === 'text') {
			return load({ host: item.host, selector: item.selector, port: item.port }, true, item.label);
		}
		if (item.kind === 'link' && item.url && isGopherUrl(item.url)) {
			return load(locationFromUrl(item.url), false, item.label);
		}
		return Promise.resolve(state);
	}

	/** Run a type-7 search: append the query and load the results as a menu. */
	function search(item, query) {
		const selector = buildSearchSelector(item.selector, query);
		return load({ host: item.host, selector, port: item.port }, false, `Search: ${query}`);
	}

	/** Restore the previous snapshot (no re-fetch). */
	function back() {
		if (history.length === 0) return Promise.resolve(state);
		setState(history.pop());
		return Promise.resolve(state);
	}

	state = freshHome();
	return { subscribe, getState, canGoBack, home, openItem, openLocation: load, search, back };
}
