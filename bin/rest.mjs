#!/usr/bin/env node
// Standalone gateway REST server entry point.
import { startGatewayRest } from '../src/rest-app.js';
import config from '../src/config.js';

startGatewayRest()
	.then((app) => {
		app.log.info({ port: config.restPort, host: config.restHost, service: config.serviceName }, 'payments-gateway REST listening');
	})
	.catch((err) => {
		console.error('payments-gateway REST failed to start:', err);
		process.exit(1);
	});
