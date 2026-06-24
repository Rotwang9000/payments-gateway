// Gopher menu primitives — the wire format behind the agent discovery
// directory. Full analysis/benchmark lives in experiments/gopher-over-https/.

import { describe, it, expect } from '@jest/globals';
import {
	ItemType, buildLine, buildMenu, parseMenu, sanitiseField,
	info, menu, textItem, link, errorItem, linkHref, typeName
} from '../src/gophermap.js';

describe('gophermap primitives', () => {
	it('compact line omits host+port; classic keeps them', () => {
		const item = menu('Seneschal', '/seneschal');
		expect(buildLine(item, { compact: true })).toBe('1Seneschal\t/seneschal');
		expect(buildLine(item, { compact: false, host: 'h.example', port: 443 }))
			.toBe('1Seneschal\t/seneschal\th.example\t443');
	});

	it('menu terminates with a lone "." and uses CRLF', () => {
		const out = buildMenu([info('hi'), menu('x', '/x')]);
		expect(out.endsWith('\r\n.\r\n')).toBe(true);
		expect(out.includes('\r\n')).toBe(true);
	});

	it('parseMenu is the inverse of buildMenu for {type,title,selector}', () => {
		const items = [info('header'), menu('A', '/a'), textItem('B', '/b'), link('C', 'https://c.example')];
		const round = parseMenu(buildMenu(items, { compact: true }), { compact: true });
		expect(round).toEqual(items.map((i) => ({ type: i.type, title: i.title, selector: i.selector })));
	});

	it('parseMenu stops at the terminator and ignores any trailer', () => {
		expect(parseMenu('1A\t/a\r\n.\r\nGARBAGE\r\n')).toEqual([{ type: '1', title: 'A', selector: '/a' }]);
	});

	it('sanitiseField strips the protocol delimiters', () => {
		expect(sanitiseField('a\tb\r\nc')).toBe('a b c');
	});

	it('rejects unknown item types', () => {
		expect(() => buildLine({ type: 'Z', title: 'x' })).toThrow(/unknown item type/);
	});

	it('link/linkHref/typeName round-trip an external URL', () => {
		const item = link('Docs', 'https://docs.example/x');
		expect(item.selector).toBe('URL:https://docs.example/x');
		expect(linkHref(item)).toBe('https://docs.example/x');
		expect(typeName(ItemType.LINK)).toBe('link');
	});

	it('errorItem builds a type-3 line', () => {
		expect(buildLine(errorItem('nope'), { compact: true })).toBe('3nope\t');
	});
});
