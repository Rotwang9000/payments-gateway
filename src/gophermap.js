// Gopher menu primitives (RFC 1436) with an HTTPS-native "compact" mode.
//
// This is the production copy of the format prototyped (with a full write-up,
// benchmark and verdict) in experiments/gopher-over-https/. It powers a
// token-cheap, drill-down discovery directory served over HTTPS — agents read
// a few hundred bytes to learn an ecosystem instead of parsing HTML/JSON.
//
// A classic Gopher menu line is four tab-separated fields:
//   <type><display-string>TAB<selector>TAB<host>TAB<port>
// terminated by a line containing only ".".
//
// Served over HTTPS, the TLS connection already supplies host+port, so the
// "compact" serialisation drops the trailing two fields:
//   <type><display-string>TAB<selector>
// which is the single biggest saving over classic Gopher.

// Item type codes — the subset an agent directory needs (full set in RFC 1436).
export const ItemType = Object.freeze({
	TEXT: '0', // a text leaf the client can fetch and read
	MENU: '1', // a submenu (directory) to drill into
	ERROR: '3', // an error line
	SEARCH: '7', // a query entry point (selector + TAB + query terms)
	INFO: 'i', // non-selectable informational text (de-facto standard)
	LINK: 'h' // external hyperlink; selector is "URL:<https url>"
});

const VALID_TYPES = new Set(Object.values(ItemType));

const CRLF = '\r\n';
const TAB = '\t';
const TERMINATOR = '.';
const CLASSIC_DEFAULT_PORT = 70;

function assert(condition, message) {
	if (!condition) throw new TypeError(`gophermap: ${message}`);
}

// TAB, CR and LF are the protocol's field/line delimiters and can never appear
// inside a display string or selector. Collapse any run of them to one space.
export function sanitiseField(value) {
	return String(value ?? '').replace(/[\t\r\n]+/g, ' ');
}

// Convenience constructors so callers never hand-build item objects — keeps the
// type codes in exactly one place.
export const info = (title) => ({ type: ItemType.INFO, title, selector: '' });
export const menu = (title, selector) => ({ type: ItemType.MENU, title, selector });
export const textItem = (title, selector) => ({ type: ItemType.TEXT, title, selector });
export const link = (title, url) => ({ type: ItemType.LINK, title, selector: `URL:${url}` });
export const errorItem = (title) => ({ type: ItemType.ERROR, title, selector: '' });

// Serialise one item to a single menu line (no trailing CRLF).
export function buildLine(item, { compact = true, host = '', port = CLASSIC_DEFAULT_PORT } = {}) {
	assert(item && typeof item === 'object', 'item must be an object');
	const type = item.type ?? ItemType.INFO;
	assert(VALID_TYPES.has(type), `unknown item type ${JSON.stringify(type)}`);
	const display = sanitiseField(item.title);
	const selector = sanitiseField(item.selector ?? '');
	if (compact) return `${type}${display}${TAB}${selector}`;
	const itemHost = sanitiseField(item.host ?? host);
	const itemPort = sanitiseField(item.port ?? port);
	return `${type}${display}${TAB}${selector}${TAB}${itemHost}${TAB}${itemPort}`;
}

// Serialise a list of items into a complete, terminated menu.
export function buildMenu(items, options = {}) {
	assert(Array.isArray(items), 'items must be an array');
	const body = items.map((item) => buildLine(item, options)).join(CRLF);
	return `${body}${CRLF}${TERMINATOR}${CRLF}`;
}

// Parse a menu back into structured items — inverse of buildMenu for the
// {type,title,selector} core; host/port restored only in classic mode.
export function parseMenu(text, { compact = true } = {}) {
	assert(typeof text === 'string', 'text must be a string');
	const items = [];
	for (const rawLine of text.split(/\r?\n/)) {
		if (rawLine === TERMINATOR) break;
		if (rawLine === '') continue;
		const type = rawLine[0];
		const fields = rawLine.slice(1).split(TAB);
		const item = { type, title: fields[0] ?? '', selector: fields[1] ?? '' };
		if (!compact) {
			if (fields[2] !== undefined) item.host = fields[2];
			if (fields[3] !== undefined) item.port = Number(fields[3]);
		}
		items.push(item);
	}
	return items;
}

const TYPE_NAMES = Object.freeze({
	'0': 'text', '1': 'menu', '3': 'error', '7': 'search', i: 'info', h: 'link'
});
export const typeName = (type) => TYPE_NAMES[type] ?? 'unknown';

// For a LINK item, recover the bare URL from its "URL:..." selector.
export function linkHref(item) {
	const sel = item?.selector ?? '';
	return sel.startsWith('URL:') ? sel.slice(4) : sel;
}
