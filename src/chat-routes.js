// Live chat — Fastify routes (REST discovery/history + a WebSocket endpoint).
//
// Surface:
//   GET  /v1/chat                    metadata: enabled, ws url, channels, limits (free)
//   GET  /v1/chat/:channel/history   recent messages for polling/preview     (free)
//   WS   /v1/chat/ws                 real-time JSON channel chat (when enabled)
//
// The WebSocket endpoint is only mounted when chat is enabled AND
// @fastify/websocket has been registered on the app (the standalone product
// registers it in rest-app.js; an embedding host that wants chat registers it
// too). The REST routes work regardless, so /v1/chat is always a safe probe.
//
// Channels mirror the notice boards by default (so #agents chat sits beside
// the agents board), reusing the board normaliser. Everything is ephemeral —
// no database, no persistence.

import { createChatHub, normaliseChannelId, CHAT_CONSTANTS } from './chat.js';
import { normaliseBoards } from './notice-board.js';

const NOOP_LOG = { info() {}, warn() {}, error() {} };
const WS_PATH = '/v1/chat/ws';

const PROTOCOL_HINT = Object.freeze({
	connect: 'open a WebSocket to the ws path; messages are JSON, one per frame',
	examples: [
		{ type: 'nick', nick: 'YourName' },
		{ type: 'join', channel: 'general' },
		{ type: 'message', channel: 'general', text: 'hello world' },
		{ type: 'list' }
	]
});

/**
 * Build the chat config block from a gateway config object. Mirrors
 * resolveAiConfig: pure, defaulting, safe to call even when the chat keys
 * are absent. Channels come from CHAT_CHANNELS, else the notice boards,
 * else a single 'general' room.
 */
export function resolveChatConfig(config = {}) {
	const source = config.chatChannels ?? config.noticeBoards ?? null;
	const channelMap = normaliseBoards(source);
	const channels = [...channelMap.values()].map((b) => ({ id: b.id, title: b.title }));
	return {
		enabled: Boolean(config.chatEnabled),
		channels,
		allowAdhocChannels: config.chatAllowAdhocChannels !== false,
		wsPath: WS_PATH,
		limits: {
			maxMessageLen: config.chatMaxMessageLen ?? CHAT_CONSTANTS.MAX_MESSAGE_LEN,
			maxChannelsPerClient: config.chatMaxChannelsPerClient ?? CHAT_CONSTANTS.MAX_CHANNELS_PER_CLIENT,
			historySize: config.chatHistorySize ?? CHAT_CONSTANTS.HISTORY_SIZE,
			ratePerMin: config.chatRatePerMin ?? CHAT_CONSTANTS.RATE_PER_MIN,
			maxChannels: config.chatMaxChannels ?? CHAT_CONSTANTS.MAX_CHANNELS,
			maxClients: config.chatMaxClients ?? CHAT_CONSTANTS.MAX_CLIENTS
		}
	};
}

/**
 * Mount the chat routes on `app`.
 *
 * deps:
 *   - chatConfig   resolved config (see resolveChatConfig); or
 *   - config       a raw gateway config (resolved here) + boards fallback
 *   - log / now    injectables
 *
 * Returns { chatReady, channels, hub }.
 */
export function registerChatRoutes(app, deps = {}) {
	const log = deps.log ?? NOOP_LOG;
	const chatConfig = deps.chatConfig ?? resolveChatConfig(deps.config ?? {});
	const enabled = chatConfig.enabled;

	const hub = enabled
		? createChatHub({
			channels: chatConfig.channels,
			limits: chatConfig.limits,
			allowAdhocChannels: chatConfig.allowAdhocChannels,
			log,
			now: deps.now
		})
		: null;

	const chatReady = () => Boolean(hub);

	// ── GET /v1/chat — always present (discovery + health probe) ──
	app.get('/v1/chat', async () => ({
		enabled,
		ws: enabled ? chatConfig.wsPath : null,
		transport: 'websocket (one JSON object per frame)',
		channels: hub ? hub.listChannels() : chatConfig.channels.map((c) => ({ ...c, members: 0, official: true })),
		limits: hub
			? {
				max_message_len: hub.limits.maxMessageLen,
				max_channels_per_client: hub.limits.maxChannelsPerClient,
				rate_per_min: hub.limits.ratePerMin,
				history_replay: hub.limits.historySize
			}
			: chatConfig.limits,
		history_endpoint: 'GET /v1/chat/{channel}/history',
		protocol: PROTOCOL_HINT,
		stats: hub ? hub.stats() : null,
		note: enabled
			? 'Open a WebSocket to the ws path and exchange JSON messages. Free, ephemeral, AIRC-style: real-time, not a log.'
			: 'Live chat is disabled on this server (operator sets CHAT_ENABLED=1 to enable).'
	}));

	// ── GET /v1/chat/:channel/history — recent buffer (polling/preview) ──
	app.get('/v1/chat/:channel/history', async (req, reply) => {
		if (!hub) {
			return reply.code(503).send({ error: { code: 'chat_disabled', message: 'live chat is disabled on this server' } });
		}
		const messages = hub.historyOf(req.params.channel);
		if (messages === null) {
			return reply.code(404).send({ error: { code: 'unknown_channel', message: `no channel #${req.params.channel}` } });
		}
		return { channel: normaliseChannelId(req.params.channel), count: messages.length, messages };
	});

	// ── WS /v1/chat/ws — real-time endpoint (enabled + plugin present) ──
	if (enabled && typeof app.hasDecorator === 'function' && app.hasDecorator('websocketServer')) {
		app.get(chatConfig.wsPath, { websocket: true }, (socket) => {
			const transport = {
				send: (obj) => { if (socket.readyState === 1) socket.send(JSON.stringify(obj)); },
				close: (code, reason) => { try { socket.close(code, reason); } catch { /* already closing */ } }
			};
			const clientId = hub.connect(transport);
			if (!clientId) return; // hub refused (at capacity) and closed the socket

			socket.on('message', (data) => {
				let str;
				try { str = typeof data === 'string' ? data : data.toString('utf8'); }
				catch { str = ''; }
				// Defence-in-depth: ws maxPayload caps frames, but bound here too.
				if (str.length > chatConfig.limits.maxMessageLen + 1024) {
					transport.send({ type: 'error', code: 'frame_too_large', message: 'frame exceeds the size limit' });
					return;
				}
				hub.handleMessage(clientId, str);
			});
			socket.on('close', () => hub.disconnect(clientId));
			socket.on('error', () => hub.disconnect(clientId));
		});
		log.info?.({ wsPath: chatConfig.wsPath, channels: chatConfig.channels.length }, 'chat: WebSocket endpoint mounted');
	} else if (enabled) {
		log.warn?.('chat: CHAT_ENABLED but @fastify/websocket is not registered — WS endpoint not mounted (REST /v1/chat still served)');
	}

	return { chatReady, channels: hub ? hub.listChannels() : chatConfig.channels, hub };
}

export default registerChatRoutes;
