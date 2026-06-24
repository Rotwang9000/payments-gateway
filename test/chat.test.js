// Unit tests for the live-chat hub. The hub is transport-agnostic, so we
// drive it with fake transports (objects that just record what was "sent")
// and a controllable clock — no sockets, no timers.

import { describe, test, expect } from '@jest/globals';
import { createChatHub, normaliseChannelId, CHAT_CONSTANTS } from '../src/chat.js';

function fakeTransport() {
	const sent = [];
	return {
		sent,
		send: (obj) => sent.push(obj),
		close: (code, reason) => sent.push({ type: '__closed', code, reason }),
		types: () => sent.map((m) => m.type),
		ofType: (t) => sent.filter((m) => m.type === t),
		last: () => sent[sent.length - 1]
	};
}

const CHANNELS = [{ id: 'general', title: 'General' }, { id: 'agents', title: 'Agents' }];

describe('normaliseChannelId', () => {
	test('strips # and lowercases', () => {
		expect(normaliseChannelId('#General')).toBe('general');
		expect(normaliseChannelId('  agents ')).toBe('agents');
	});
	test('rejects bad shapes', () => {
		expect(normaliseChannelId('a')).toBeNull();         // too short
		expect(normaliseChannelId('Has Space')).toBeNull();
		expect(normaliseChannelId('UPPER')).toBe('upper');  // lowercased then ok
		expect(normaliseChannelId(42)).toBeNull();
		expect(normaliseChannelId('x'.repeat(40))).toBeNull();
	});
});

describe('createChatHub — connect + welcome', () => {
	test('welcome carries official channels, limits and protocol', () => {
		const hub = createChatHub({ channels: CHANNELS });
		const t = fakeTransport();
		const id = hub.connect(t);
		expect(id).toBeTruthy();
		const welcome = t.ofType('welcome')[0];
		expect(welcome).toBeTruthy();
		expect(welcome.channels.map((c) => c.id)).toEqual(['general', 'agents']);
		expect(welcome.limits.max_message_len).toBe(CHAT_CONSTANTS.MAX_MESSAGE_LEN);
		expect(welcome.protocol).toBeTruthy();
		expect(welcome.nick).toMatch(/^anon-/);
	});

	test('falls back to a single general channel when none supplied', () => {
		const hub = createChatHub({});
		const t = fakeTransport();
		hub.connect(t);
		expect(t.ofType('welcome')[0].channels.map((c) => c.id)).toEqual(['general']);
	});

	test('rejects connections past maxClients', () => {
		const hub = createChatHub({ channels: CHANNELS, limits: { maxClients: 1 } });
		expect(hub.connect(fakeTransport())).toBeTruthy();
		const t2 = fakeTransport();
		expect(hub.connect(t2)).toBeNull();
		expect(t2.ofType('error')[0].code).toBe('server_full');
		expect(t2.last().type).toBe('__closed');
	});
});

describe('nick', () => {
	test('valid nick is accepted and echoed', () => {
		const hub = createChatHub({ channels: CHANNELS });
		const t = fakeTransport();
		const id = hub.connect(t);
		hub.handleMessage(id, { type: 'nick', nick: 'Ada' });
		expect(t.ofType('nick').some((m) => m.nick === 'Ada')).toBe(true);
	});

	test('invalid nick is rejected', () => {
		const hub = createChatHub({ channels: CHANNELS });
		const t = fakeTransport();
		const id = hub.connect(t);
		hub.handleMessage(id, { type: 'nick', nick: 'has space' });
		expect(t.ofType('error')[0].code).toBe('bad_nick');
	});

	test('rename is broadcast to channel peers', () => {
		const hub = createChatHub({ channels: CHANNELS });
		const a = fakeTransport(); const ai = hub.connect(a);
		const b = fakeTransport(); const bi = hub.connect(b);
		hub.handleMessage(ai, { type: 'join', channel: 'general' });
		hub.handleMessage(bi, { type: 'join', channel: 'general' });
		hub.handleMessage(ai, { type: 'nick', nick: 'Ada' });
		const peerSawRename = b.ofType('nick').find((m) => m.from && m.nick === 'Ada');
		expect(peerSawRename).toBeTruthy();
		expect(peerSawRename.channel).toBe('general');
	});
});

describe('join / names / history', () => {
	test('join returns names + (empty) history and broadcasts to peers', () => {
		const hub = createChatHub({ channels: CHANNELS });
		const a = fakeTransport(); const ai = hub.connect(a);
		hub.handleMessage(ai, { type: 'nick', nick: 'Ada' });
		hub.handleMessage(ai, { type: 'join', channel: 'general' });
		const joined = a.ofType('joined')[0];
		expect(joined.channel).toBe('general');
		expect(joined.names).toContain('Ada');
		expect(Array.isArray(joined.history)).toBe(true);

		const b = fakeTransport(); const bi = hub.connect(b);
		hub.handleMessage(bi, { type: 'nick', nick: 'Bob' });
		hub.handleMessage(bi, { type: 'join', channel: 'general' });
		// Ada (already in channel) should have seen Bob's join broadcast.
		expect(a.ofType('join').some((m) => m.nick === 'Bob')).toBe(true);
	});

	test('join replays recent history to a later joiner', () => {
		const hub = createChatHub({ channels: CHANNELS });
		const a = fakeTransport(); const ai = hub.connect(a);
		hub.handleMessage(ai, { type: 'join', channel: 'general' });
		hub.handleMessage(ai, { type: 'message', channel: 'general', text: 'first!' });

		const b = fakeTransport(); const bi = hub.connect(b);
		hub.handleMessage(bi, { type: 'join', channel: 'general' });
		const joined = b.ofType('joined')[0];
		expect(joined.history.map((m) => m.text)).toContain('first!');
	});

	test('history ring buffer is capped at historySize', () => {
		const hub = createChatHub({ channels: CHANNELS, limits: { historySize: 3, ratePerMin: 1000 } });
		const a = fakeTransport(); const ai = hub.connect(a);
		hub.handleMessage(ai, { type: 'join', channel: 'general' });
		for (let i = 0; i < 6; i++) hub.handleMessage(ai, { type: 'message', channel: 'general', text: `m${i}` });
		expect(hub.historyOf('general').map((m) => m.text)).toEqual(['m3', 'm4', 'm5']);
	});

	test('ad-hoc channel is created on join when allowed', () => {
		const hub = createChatHub({ channels: CHANNELS });
		const a = fakeTransport(); const ai = hub.connect(a);
		hub.handleMessage(ai, { type: 'join', channel: '#random' });
		expect(a.ofType('joined')[0].channel).toBe('random');
		expect(hub.listChannels().some((c) => c.id === 'random' && c.official === false)).toBe(true);
	});

	test('ad-hoc join is refused when disabled', () => {
		const hub = createChatHub({ channels: CHANNELS, allowAdhocChannels: false });
		const a = fakeTransport(); const ai = hub.connect(a);
		hub.handleMessage(ai, { type: 'join', channel: 'random' });
		expect(a.ofType('error')[0].code).toBe('unknown_channel');
	});

	test('per-client channel cap is enforced', () => {
		const hub = createChatHub({ channels: CHANNELS, limits: { maxChannelsPerClient: 2 } });
		const a = fakeTransport(); const ai = hub.connect(a);
		hub.handleMessage(ai, { type: 'join', channel: 'general' });
		hub.handleMessage(ai, { type: 'join', channel: 'agents' });
		hub.handleMessage(ai, { type: 'join', channel: 'third' });
		expect(a.ofType('error').some((m) => m.code === 'too_many_channels')).toBe(true);
	});
});

describe('message', () => {
	test('broadcasts to all members including the sender', () => {
		const hub = createChatHub({ channels: CHANNELS });
		const a = fakeTransport(); const ai = hub.connect(a);
		const b = fakeTransport(); const bi = hub.connect(b);
		hub.handleMessage(ai, { type: 'nick', nick: 'Ada' });
		hub.handleMessage(ai, { type: 'join', channel: 'general' });
		hub.handleMessage(bi, { type: 'join', channel: 'general' });
		hub.handleMessage(ai, { type: 'message', channel: 'general', text: 'hi all' });
		expect(a.ofType('message').some((m) => m.text === 'hi all' && m.nick === 'Ada')).toBe(true);
		expect(b.ofType('message').some((m) => m.text === 'hi all' && m.nick === 'Ada')).toBe(true);
	});

	test('refuses posting to a channel you have not joined', () => {
		const hub = createChatHub({ channels: CHANNELS });
		const a = fakeTransport(); const ai = hub.connect(a);
		hub.handleMessage(ai, { type: 'message', channel: 'general', text: 'hi' });
		expect(a.ofType('error')[0].code).toBe('not_joined');
	});

	test('rejects empty and over-long messages', () => {
		const hub = createChatHub({ channels: CHANNELS, limits: { maxMessageLen: 10 } });
		const a = fakeTransport(); const ai = hub.connect(a);
		hub.handleMessage(ai, { type: 'join', channel: 'general' });
		hub.handleMessage(ai, { type: 'message', channel: 'general', text: '   ' });
		expect(a.ofType('error').some((m) => m.code === 'empty_message')).toBe(true);
		hub.handleMessage(ai, { type: 'message', channel: 'general', text: 'this is way too long' });
		expect(a.ofType('error').some((m) => m.code === 'message_too_long')).toBe(true);
	});

	test('accepts the { content } alias', () => {
		const hub = createChatHub({ channels: CHANNELS });
		const a = fakeTransport(); const ai = hub.connect(a);
		hub.handleMessage(ai, { type: 'join', channel: 'general' });
		hub.handleMessage(ai, { type: 'msg', channel: 'general', content: 'via content' });
		expect(a.ofType('message').some((m) => m.text === 'via content')).toBe(true);
	});

	test('enforces the per-minute rate limit using the injected clock', () => {
		let t = 1_000_000;
		const hub = createChatHub({ channels: CHANNELS, limits: { ratePerMin: 2 }, now: () => t });
		const a = fakeTransport(); const ai = hub.connect(a);
		hub.handleMessage(ai, { type: 'join', channel: 'general' });
		hub.handleMessage(ai, { type: 'message', channel: 'general', text: 'one' });
		hub.handleMessage(ai, { type: 'message', channel: 'general', text: 'two' });
		hub.handleMessage(ai, { type: 'message', channel: 'general', text: 'three' });
		expect(a.ofType('error').some((m) => m.code === 'rate_limited')).toBe(true);
		// advance past the window — sending is allowed again
		t += 61_000;
		hub.handleMessage(ai, { type: 'message', channel: 'general', text: 'later' });
		expect(a.ofType('message').some((m) => m.text === 'later')).toBe(true);
	});
});

describe('list / part / disconnect', () => {
	test('list returns all channels with member counts', () => {
		const hub = createChatHub({ channels: CHANNELS });
		const a = fakeTransport(); const ai = hub.connect(a);
		hub.handleMessage(ai, { type: 'join', channel: 'general' });
		hub.handleMessage(ai, { type: 'list' });
		const channels = a.ofType('channels')[0].channels;
		expect(channels.find((c) => c.id === 'general').members).toBe(1);
	});

	test('part removes membership and notifies peers', () => {
		const hub = createChatHub({ channels: CHANNELS });
		const a = fakeTransport(); const ai = hub.connect(a);
		const b = fakeTransport(); const bi = hub.connect(b);
		hub.handleMessage(ai, { type: 'nick', nick: 'Ada' });
		hub.handleMessage(ai, { type: 'join', channel: 'general' });
		hub.handleMessage(bi, { type: 'join', channel: 'general' });
		hub.handleMessage(ai, { type: 'part', channel: 'general' });
		expect(a.ofType('parted')[0].channel).toBe('general');
		expect(b.ofType('part').some((m) => m.nick === 'Ada')).toBe(true);
	});

	test('disconnect drops the client from its channels and notifies peers', () => {
		const hub = createChatHub({ channels: CHANNELS });
		const a = fakeTransport(); const ai = hub.connect(a);
		const b = fakeTransport(); const bi = hub.connect(b);
		hub.handleMessage(ai, { type: 'nick', nick: 'Ada' });
		hub.handleMessage(ai, { type: 'join', channel: 'general' });
		hub.handleMessage(bi, { type: 'join', channel: 'general' });
		hub.disconnect(ai);
		expect(b.ofType('part').some((m) => m.nick === 'Ada')).toBe(true);
		expect(hub.stats().clients).toBe(1);
	});
});

describe('bad input', () => {
	test('non-JSON string yields a bad_json error', () => {
		const hub = createChatHub({ channels: CHANNELS });
		const a = fakeTransport(); const ai = hub.connect(a);
		hub.handleMessage(ai, 'not json {');
		expect(a.ofType('error')[0].code).toBe('bad_json');
	});

	test('object without a string type yields bad_message', () => {
		const hub = createChatHub({ channels: CHANNELS });
		const a = fakeTransport(); const ai = hub.connect(a);
		hub.handleMessage(ai, { hello: 'world' });
		expect(a.ofType('error')[0].code).toBe('bad_message');
	});

	test('unknown type is reported', () => {
		const hub = createChatHub({ channels: CHANNELS });
		const a = fakeTransport(); const ai = hub.connect(a);
		hub.handleMessage(ai, { type: 'frobnicate' });
		expect(a.ofType('error')[0].code).toBe('unknown_type');
	});

	test('ping is answered with pong', () => {
		const hub = createChatHub({ channels: CHANNELS });
		const a = fakeTransport(); const ai = hub.connect(a);
		hub.handleMessage(ai, { type: 'ping' });
		expect(a.ofType('pong').length).toBe(1);
	});
});
