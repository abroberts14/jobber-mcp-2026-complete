/**
 * Load .env into process.env before anything reads config.
 *
 * Uses Node's built-in loader (Node >= 20.12) so the server stays
 * dependency-free. Missing file is fine — env vars may come from the MCP client
 * config instead.
 */

import { join } from 'node:path';

export function loadEnv(path = process.env.JOBBER_ENV_FILE || join(process.cwd(), '.env')): void {
  try {
    process.loadEnvFile(path);
  } catch {
    // No .env present, or this Node is too old for loadEnvFile. Either way the
    // process environment is the source of truth from here on.
  }
}
