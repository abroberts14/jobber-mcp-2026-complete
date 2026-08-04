/**
 * Persistence for Jobber OAuth tokens.
 *
 * Jobber rotates the refresh token on every refresh, so the newest one has to
 * survive a restart. Keeping it in a JSON file (rather than rewriting .env)
 * means the .env stays the user-owned bootstrap config and the store holds the
 * moving parts.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { JobberTokens } from '../types/jobber.js';

export function defaultTokenStorePath(): string {
  return process.env.JOBBER_TOKEN_STORE || join(homedir(), '.jobber-mcp', 'tokens.json');
}

export class TokenStore {
  constructor(private readonly path: string = defaultTokenStorePath()) {}

  async read(): Promise<JobberTokens | null> {
    try {
      const raw = await readFile(this.path, 'utf8');
      const parsed = JSON.parse(raw) as Partial<JobberTokens>;
      if (!parsed.refreshToken) return null;
      return {
        accessToken: parsed.accessToken ?? '',
        refreshToken: parsed.refreshToken,
        expiresAt: parsed.expiresAt ?? 0,
      };
    } catch {
      // Missing or unreadable store just means "bootstrap from .env".
      return null;
    }
  }

  async write(tokens: JobberTokens): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  }
}
