#!/usr/bin/env node
/**
 * Jobber MCP Server Entry Point
 */

import { loadEnv } from './load-env.js';
import { JobberServer } from './server.js';

loadEnv();

const server = new JobberServer();

server.run().catch((error) => {
  console.error('Fatal error in Jobber MCP server:', error);
  process.exit(1);
});
