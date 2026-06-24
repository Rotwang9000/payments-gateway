// Tests for the chat REST surface (GET /v1/chat + history) via Fastify
// inject. The WebSocket route is gated on @fastify/websocket being present,
// so with a bare app only the REST routes register — exactly what we probe.

import { describe, test, expect } from '@jest/globals';
import Fastify from 'fastify';
import { registerChatRoutes, resolveChatConfig } from '../src/chat-routes.js';

async function appWith(chatConfig) {
	const app = Fastify();
	registerChatRoutes(app, { chatConfig });
	await app.ready();
	return app;
}

describe('resolveChatConfig', () => {
	test('derives channels from the notice boards', () => {
		const cfg = resolveChatConfig({
			chatEnabled: true,
			noticeBoards: [{ id: 'general', title: 'General' }, { id: 'agents', title: 'Agents' }]
		});
		expect(cfg.enabled).toBe(true);
		expect(cfg.channels.map((c) => c.id)).toEqual(['general', 'agents']);
		expect(cfg.wsPath).toBe('/v1/chat/ws');
	});

	test('CHAT_CHANNELS overrides the boards', () => {
		const cfg = resolveChatConfig({ chatEnabled: true, chatChannels: [{ id: 'lobby', title: 'Lobby' }], noticeBoards: [{ id: 'general' }] });
		expect(cfg.channels.map((c) => c.id)).toEqual(['lobby']);
	});

	test('disabled by default; defaults to a general channel with no boards', () => {
		const cfg = resolveChatConfig({});
		expect(cfg.enabled).toBe(false);
		expect(cfg.channels.map((c) => c.id)).toEqual(['general']);
	});
});

describe('GET /v1/chat — disabled', () => {
	test('reports enabled:false and a null ws url', async () => {
		const app = await appWith(resolveChatConfig({}));
		const res = await app.inject({ method: 'GET', url: '/v1/chat' });
		expect(res.statusCode).toBe(200);
		const j = res.json();
		expect(j.enabled).toBe(false);
		expect(j.ws).toBeNull();
		await app.close();
	});

	test('history endpoint answers 503 when disabled', async () => {
		const app = await appWith(resolveChatConfig({}));
		const res = await app.inject({ method: 'GET', url: '/v1/chat/general/history' });
		expect(res.statusCode).toBe(503);
		expect(res.json().error.code).toBe('chat_disabled');
		await app.close();
	});
});

describe('GET /v1/chat — enabled', () => {
	const enabled = () => resolveChatConfig({
		chatEnabled: true,
		noticeBoards: [{ id: 'general', title: 'General' }, { id: 'agents', title: 'Agents' }]
	});

	test('advertises ws path, channels and limits', async () => {
		const app = await appWith(enabled());
		const j = (await app.inject({ method: 'GET', url: '/v1/chat' })).json();
		expect(j.enabled).toBe(true);
		expect(j.ws).toBe('/v1/chat/ws');
		expect(j.channels.map((c) => c.id)).toEqual(['general', 'agents']);
		expect(j.limits.max_message_len).toBe(400);
		await app.close();
	});

	test('history of a known channel starts empty', async () => {
		const app = await appWith(enabled());
		const res = await app.inject({ method: 'GET', url: '/v1/chat/general/history' });
		expect(res.statusCode).toBe(200);
		expect(res.json()).toMatchObject({ channel: 'general', count: 0, messages: [] });
		await app.close();
	});

	test('history of an unknown channel → 404', async () => {
		const app = await appWith(enabled());
		const res = await app.inject({ method: 'GET', url: '/v1/chat/nope-nope/history' });
		expect(res.statusCode).toBe(404);
		expect(res.json().error.code).toBe('unknown_channel');
		await app.close();
	});
});
