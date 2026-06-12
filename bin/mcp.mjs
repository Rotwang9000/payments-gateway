#!/usr/bin/env node
// Standalone gateway MCP server entry point.
import { startGatewayMcpHttpServer } from '../src/mcp-tools.js';
import { createMakePaymentService } from '../src/make-payment.js';
import { buildMakePaymentDeps } from '../src/make-payment-deps.js';
import config from '../src/config.js';

// One shared make-payment service (when a .wult share is configured) so
// payment state survives across the stateless per-request MCP servers.
const makePaymentService = config.makePaymentWultPath
	? createMakePaymentService({ config, deps: buildMakePaymentDeps(config) })
	: null;

startGatewayMcpHttpServer({
	toolPrefix: config.toolPrefix,
	...(makePaymentService ? { makePaymentService } : {})
})
	.then(() => {
		console.log(JSON.stringify({
			level: 'info',
			msg: 'payments-gateway MCP listening',
			port: config.mcpPort,
			host: config.mcpHost,
			service: config.serviceName,
			makePayments: Boolean(makePaymentService)
		}));
	})
	.catch((err) => {
		console.error('payments-gateway MCP failed to start:', err);
		process.exit(1);
	});
