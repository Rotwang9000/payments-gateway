// Live chat hub — AIRC-style real-time channels, transport-agnostic.
//
// This module is the pure, in-memory engine: it knows nothing about
// WebSockets. A transport (see chat-routes.js) hands the hub a `client`
// object exposing `send(obj)` and `close(code, reason)`; the hub manages
// nicks, channel membership, a small recent-message ring buffer (replayed
// to joiners), and the limits (message length, per-client rate, channel
// caps). Keeping it transport-free means the whole protocol is unit-testable
// with fake transports — no sockets, no timers.
//
// Everything is ephemeral: state lives in Maps and dies with the process.
// That matches AIRC's design (real-time, not a log) and means the chat adds
// no database or persistence surface to the gateway.

const NOOP_LOG = { info() {}, warn() {}, error() {} };

export const CHAT_CONSTANTS = Object.freeze({
	MAX_MESSAGE_LEN: 400,
	MAX_CHANNELS_PER_CLIENT: 10,
	HISTORY_SIZE: 50,
	RATE_PER_MIN: 30,
	MAX_CHANNELS: 100,
	MAX_CLIENTS: 500,
	NICK_MAX: 24,
	// Channel ids share the notice-board id shape (lowercase, 2–39).
	CHANNEL_ID_RE: /^[a-z0-9-]{2,39}$/,
	// IRC-ish nick: letters, digits and a few punctuation marks.
	NICK_RE: /^[A-Za-z0-9_\-[\]{}|.^`]{1,24}$/
});

// Short machine-readable protocol hint, sent on connect so a freshly
// connected agent can self-describe without out-of-band docs.
const PROTOCOL_HINT = Object.freeze({
	send: {
		nick: { type: 'nick', nick: 'YourName' },
		join: { type: 'join', channel: 'general' },
		message: { type: 'message', channel: 'general', text: 'hello' },
		part: { type: 'part', channel: 'general' },
		list: { type: 'list' },
		names: { type: 'names', channel: 'general' },
		ping: { type: 'ping' }
	},
	receive: ['welcome', 'nick', 'joined', 'join', 'part', 'message', 'channels', 'names', 'pong', 'error']
});

/** Normalise a channel reference ("#General" / " general ") → "general" or null. */
export function normaliseChannelId(raw) {
	if (typeof raw !== 'string') return null;
	let id = raw.trim().toLowerCase();
	if (id.startsWith('#')) id = id.slice(1);
	return CHAT_CONSTANTS.CHANNEL_ID_RE.test(id) ? id : null;
}

function isValidNick(nick) {
	return typeof nick === 'string' && CHAT_CONSTANTS.NICK_RE.test(nick);
}

function errObj(code, message) {
	return { type: 'error', code, message };
}

/**
 * Create a chat hub.
 *
 * opts:
 *   - channels   array of { id, title } official channels (always present)
 *   - limits     { maxMessageLen, maxChannelsPerClient, historySize,
 *                  ratePerMin, maxChannels, maxClients }
 *   - allowAdhocChannels  create channels on join (default true)
 *   - now / log  injectables
 *
 * Returns a handle with connect/handleMessage/disconnect plus introspection
 * (stats, listChannels) used by the REST surface and tests.
 */
export function createChatHub(opts = {}) {
	const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
	const log = opts.log ?? NOOP_LOG;
	const allowAdhoc = opts.allowAdhocChannels !== false;
	const limits = Object.freeze({
		maxMessageLen: opts.limits?.maxMessageLen ?? CHAT_CONSTANTS.MAX_MESSAGE_LEN,
		maxChannelsPerClient: opts.limits?.maxChannelsPerClient ?? CHAT_CONSTANTS.MAX_CHANNELS_PER_CLIENT,
		historySize: opts.limits?.historySize ?? CHAT_CONSTANTS.HISTORY_SIZE,
		ratePerMin: opts.limits?.ratePerMin ?? CHAT_CONSTANTS.RATE_PER_MIN,
		maxChannels: opts.limits?.maxChannels ?? CHAT_CONSTANTS.MAX_CHANNELS,
		maxClients: opts.limits?.maxClients ?? CHAT_CONSTANTS.MAX_CLIENTS
	});

	// channelId -> { id, title, official, members:Set<clientId>, history:[] }
	const channels = new Map();
	// clientId -> { id, nick, transport, joined:Set<channelId>, msgTimes:[], connectedAt }
	const clients = new Map();
	let seq = 0;

	function makeChannel(id, title, official) {
		return { id, title: title || `#${id}`, official: Boolean(official), members: new Set(), history: [] };
	}

	for (const c of Array.isArray(opts.channels) ? opts.channels : []) {
		const id = normaliseChannelId(c?.id);
		if (id && !channels.has(id)) channels.set(id, makeChannel(id, c?.title, true));
	}
	// Always provide a default room so a bare client has somewhere to go.
	if (channels.size === 0) channels.set('general', makeChannel('general', 'General', true));

	function send(client, obj) {
		if (!client?.transport) return;
		try { client.transport.send(obj); }
		catch (err) { log.warn?.({ err: err?.message ?? String(err), client: client.id }, 'chat: send failed'); }
	}

	function broadcast(channel, obj, exceptId = null) {
		for (const cid of channel.members) {
			if (cid === exceptId) continue;
			const c = clients.get(cid);
			if (c) send(c, obj);
		}
	}

	function namesOf(channel) {
		const out = [];
		for (const cid of channel.members) {
			const c = clients.get(cid);
			if (c) out.push(c.nick);
		}
		return out;
	}

	function officialList() {
		return [...channels.values()].filter((c) => c.official).map((c) => ({ id: c.id, title: c.title }));
	}

	function publicLimits() {
		return {
			max_message_len: limits.maxMessageLen,
			max_channels_per_client: limits.maxChannelsPerClient,
			rate_per_min: limits.ratePerMin,
			history_replay: limits.historySize
		};
	}

	function pushHistory(channel, msg) {
		channel.history.push(msg);
		if (channel.history.length > limits.historySize) {
			channel.history.splice(0, channel.history.length - limits.historySize);
		}
	}

	function rateOk(client) {
		const t = now();
		const cutoff = t - 60_000;
		client.msgTimes = client.msgTimes.filter((ts) => ts > cutoff);
		if (client.msgTimes.length >= limits.ratePerMin) return false;
		client.msgTimes.push(t);
		return true;
	}

	function connect(transport) {
		if (clients.size >= limits.maxClients) {
			try { transport.send?.(errObj('server_full', 'chat is at capacity; try again shortly')); } catch { /* ignore */ }
			try { transport.close?.(1013, 'server full'); } catch { /* ignore */ }
			return null;
		}
		const id = `c${++seq}`;
		const client = { id, nick: `anon-${id}`, transport, joined: new Set(), msgTimes: [], connectedAt: now() };
		clients.set(id, client);
		send(client, {
			type: 'welcome',
			nick: client.nick,
			channels: officialList(),
			limits: publicLimits(),
			protocol: PROTOCOL_HINT
		});
		return id;
	}

	function doNick(client, msg) {
		const nick = typeof msg.nick === 'string' ? msg.nick.trim() : '';
		if (!isValidNick(nick)) {
			return send(client, errObj('bad_nick', `nick must match ${CHAT_CONSTANTS.NICK_RE} (max ${CHAT_CONSTANTS.NICK_MAX})`));
		}
		const prev = client.nick;
		client.nick = nick;
		send(client, { type: 'nick', nick });
		// Tell every room the client is in about the rename.
		const seen = new Set();
		for (const cid of client.joined) {
			const ch = channels.get(cid);
			if (ch) broadcast(ch, { type: 'nick', channel: cid, from: prev, nick }, client.id);
			seen.add(cid);
		}
	}

	function doJoin(client, msg) {
		const id = normaliseChannelId(msg.channel);
		if (!id) return send(client, errObj('bad_channel', 'channel must be 2–39 chars of [a-z0-9-]'));
		if (!client.joined.has(id) && client.joined.size >= limits.maxChannelsPerClient) {
			return send(client, errObj('too_many_channels', `you may be in at most ${limits.maxChannelsPerClient} channels`));
		}
		let ch = channels.get(id);
		if (!ch) {
			if (!allowAdhoc) return send(client, errObj('unknown_channel', `no channel #${id}; see { type: "list" }`));
			if (channels.size >= limits.maxChannels) return send(client, errObj('channel_limit', 'server channel limit reached'));
			ch = makeChannel(id, `#${id}`, false);
			channels.set(id, ch);
		}
		const already = ch.members.has(client.id);
		ch.members.add(client.id);
		client.joined.add(id);
		send(client, { type: 'joined', channel: id, title: ch.title, names: namesOf(ch), history: ch.history.slice() });
		if (!already) broadcast(ch, { type: 'join', channel: id, nick: client.nick }, client.id);
	}

	function doPart(client, msg) {
		const id = normaliseChannelId(msg.channel);
		if (!id) return send(client, errObj('bad_channel', 'channel must be 2–39 chars of [a-z0-9-]'));
		const ch = channels.get(id);
		if (ch && ch.members.delete(client.id)) {
			client.joined.delete(id);
			broadcast(ch, { type: 'part', channel: id, nick: client.nick });
		}
		send(client, { type: 'parted', channel: id });
	}

	function doMessage(client, msg) {
		const id = normaliseChannelId(msg.channel);
		if (!id) return send(client, errObj('bad_channel', 'channel must be 2–39 chars of [a-z0-9-]'));
		const ch = channels.get(id);
		if (!ch || !ch.members.has(client.id)) return send(client, errObj('not_joined', `join #${id} before posting`));
		const raw = typeof msg.text === 'string' ? msg.text : (typeof msg.content === 'string' ? msg.content : '');
		const text = raw.replace(/\s+$/u, '');
		if (!text) return send(client, errObj('empty_message', 'message text is empty'));
		if (text.length > limits.maxMessageLen) {
			return send(client, errObj('message_too_long', `messages are limited to ${limits.maxMessageLen} characters`));
		}
		if (!rateOk(client)) return send(client, errObj('rate_limited', `slow down — at most ${limits.ratePerMin} messages per minute`));
		const out = { type: 'message', channel: id, nick: client.nick, text, ts: now() };
		pushHistory(ch, out);
		broadcast(ch, out);
	}

	function doList(client) {
		send(client, {
			type: 'channels',
			channels: [...channels.values()].map((c) => ({ id: c.id, title: c.title, members: c.members.size, official: c.official }))
		});
	}

	function doNames(client, msg) {
		const id = normaliseChannelId(msg.channel);
		if (!id) return send(client, errObj('bad_channel', 'channel must be 2–39 chars of [a-z0-9-]'));
		const ch = channels.get(id);
		if (!ch) return send(client, errObj('unknown_channel', `no channel #${id}`));
		send(client, { type: 'names', channel: id, names: namesOf(ch) });
	}

	function handleMessage(clientId, raw) {
		const client = clients.get(clientId);
		if (!client) return;
		let msg;
		try { msg = typeof raw === 'string' ? JSON.parse(raw) : raw; }
		catch { return send(client, errObj('bad_json', 'message was not valid JSON')); }
		if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
			return send(client, errObj('bad_message', 'expected a JSON object with a string "type"'));
		}
		switch (msg.type) {
			case 'nick': return doNick(client, msg);
			case 'join': return doJoin(client, msg);
			case 'part': case 'leave': return doPart(client, msg);
			case 'message': case 'msg': case 'say': return doMessage(client, msg);
			case 'list': return doList(client);
			case 'names': return doNames(client, msg);
			case 'ping': return send(client, { type: 'pong', ts: now() });
			default: return send(client, errObj('unknown_type', `unknown message type "${msg.type}"`));
		}
	}

	function disconnect(clientId) {
		const client = clients.get(clientId);
		if (!client) return;
		for (const cid of client.joined) {
			const ch = channels.get(cid);
			if (ch && ch.members.delete(client.id)) {
				broadcast(ch, { type: 'part', channel: cid, nick: client.nick });
			}
		}
		clients.delete(clientId);
	}

	function historyOf(channelId) {
		const id = normaliseChannelId(channelId);
		const ch = id ? channels.get(id) : null;
		return ch ? ch.history.slice() : null;
	}

	function stats() {
		let messages = 0;
		for (const ch of channels.values()) messages += ch.history.length;
		return {
			clients: clients.size,
			channels: channels.size,
			official_channels: officialList().length,
			buffered_messages: messages
		};
	}

	function listChannels() {
		return [...channels.values()].map((c) => ({ id: c.id, title: c.title, members: c.members.size, official: c.official }));
	}

	return {
		connect,
		handleMessage,
		disconnect,
		historyOf,
		stats,
		listChannels,
		limits,
		// exposed for tests / introspection
		_channels: channels,
		_clients: clients
	};
}

export default createChatHub;
