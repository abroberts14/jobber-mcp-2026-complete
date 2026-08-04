/**
 * Persistence and cross-process coordination for Jobber OAuth tokens.
 *
 * Jobber rotates the refresh token on every refresh and the old one is
 * immediately dead, so a refresh must be serialised across every process
 * sharing this store — multiple stdio servers on a laptop, or overlapping
 * containers on a shared volume during a rolling deploy. Two processes
 * refreshing concurrently means one of them is left holding a burned token.
 *
 * The lock is an O_EXCL lockfile: no dependency, and it works across containers
 * on the same mount, which an in-process mutex would not.
 */

import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { JobberTokens } from '../types/jobber.js';

/** Give up rather than hang forever if a lock can't be taken. */
const LOCK_TIMEOUT_MS = 15_000;

/** A lock older than this is assumed to be from a process that died holding it. */
const LOCK_STALE_MS = 30_000;

const LOCK_POLL_MS = 100;

export function defaultTokenStorePath(): string {
  return process.env.JOBBER_TOKEN_STORE || join(homedir(), '.jobber-mcp', 'tokens.json');
}

export class TokenStore {
  private readonly lockPath: string;

  constructor(private readonly path: string = defaultTokenStorePath()) {
    this.lockPath = `${this.path}.lock`;
  }

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

  /**
   * Write atomically. A torn token file would take the whole server down until
   * someone re-authorized by hand, and rename(2) is atomic within a filesystem.
   */
  async write(tokens: JobberTokens): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(tokens, null, 2), { mode: 0o600 });
    await rename(tmp, this.path);
  }

  /**
   * Run `fn` with the store lock held. Whoever wins re-reads the store first, so
   * a process that lost the race adopts the winner's tokens instead of burning
   * the refresh token a second time.
   */
  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      await unlink(this.lockPath).catch(() => {
        // Already gone (e.g. broken as stale by another process) — nothing to do.
      });
    }
  }

  private async acquire(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const deadline = Date.now() + LOCK_TIMEOUT_MS;

    for (;;) {
      try {
        const handle = await open(this.lockPath, 'wx');
        await handle.writeFile(String(process.pid));
        await handle.close();
        return;
      } catch (error: any) {
        if (error?.code !== 'EEXIST') throw error;

        if (await this.breakIfStale()) continue;

        if (Date.now() >= deadline) {
          throw new Error(
            `Timed out waiting for the Jobber token lock at ${this.lockPath}. ` +
              'If no other jobber-mcp process is running, delete that file.'
          );
        }

        await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
      }
    }
  }

  /** @returns true if a stale lock was removed and acquisition should retry. */
  private async breakIfStale(): Promise<boolean> {
    try {
      const { mtimeMs } = await stat(this.lockPath);
      if (Date.now() - mtimeMs < LOCK_STALE_MS) return false;
      await unlink(this.lockPath);
      return true;
    } catch {
      // Vanished underneath us — retrying will now succeed.
      return true;
    }
  }
}
