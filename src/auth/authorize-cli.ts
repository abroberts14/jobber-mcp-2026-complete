#!/usr/bin/env node
/**
 * One-time OAuth bootstrap.
 *
 * Jobber issues no static API tokens, so the refresh token has to come from an
 * interactive authorization code grant. This walks through it once and prints
 * the values to put in .env.
 *
 *   npm run authorize
 */

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { spawn } from 'node:child_process';
import { loadEnv } from '../load-env.js';
import { authorizeUrl, exchangeCode } from './oauth.js';
import { TokenStore, defaultTokenStorePath } from './token-store.js';

loadEnv();

const clientId = process.env.JOBBER_CLIENT_ID;
const clientSecret = process.env.JOBBER_CLIENT_SECRET;
const redirectUri = process.env.JOBBER_REDIRECT_URI || 'http://localhost:3000/callback';
const oauthUrl = process.env.JOBBER_OAUTH_URL;

if (!clientId || !clientSecret) {
  console.error(
    'JOBBER_CLIENT_ID and JOBBER_CLIENT_SECRET must be set in .env.\n' +
      'Find them under your app in https://developer.getjobber.com.'
  );
  process.exit(1);
}

const state = randomUUID();
const url = authorizeUrl({ clientId, redirectUri, state, oauthUrl });

console.log('\nOpen this URL and approve the app:\n');
console.log(`  ${url}\n`);
console.log(`Redirect URI in use: ${redirectUri}`);
console.log('(It must exactly match the one registered on your Jobber app.)\n');

openInBrowser(url);

// A tunnelled redirect URI (ngrok et al) still terminates on a local port, so
// listen whenever we know the port — loopback implies it, JOBBER_CALLBACK_PORT
// states it explicitly. Otherwise fall back to pasting the code in.
const callbackPort = process.env.JOBBER_CALLBACK_PORT;
const canListen = isLoopback(redirectUri) || Boolean(callbackPort);
const code = canListen ? await waitForCallback() : await promptForCode();

const tokens = await exchangeCode({ clientId, clientSecret, code, redirectUri, oauthUrl });
await new TokenStore().write(tokens);

console.log('\nAuthorized. Add this to your .env:\n');
console.log(`JOBBER_REFRESH_TOKEN=${tokens.refreshToken}\n`);
console.log(`Tokens were also cached at ${defaultTokenStorePath()}.`);
console.log(
  'The server refreshes the access token automatically and rewrites that cache\n' +
    'as Jobber rotates the refresh token.\n'
);

process.exit(0);

function isLoopback(uri: string): boolean {
  try {
    const { hostname } = new URL(uri);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  } catch {
    return false;
  }
}

/** Catch the redirect on localhost so the code never has to be copied by hand. */
function waitForCallback(): Promise<string> {
  const { port, pathname } = new URL(redirectUri);
  const listenPort = Number(callbackPort || port || 80);

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const requestUrl = new URL(req.url || '/', redirectUri);
      if (requestUrl.pathname !== pathname) {
        res.writeHead(404).end('Not found');
        return;
      }

      const error = requestUrl.searchParams.get('error');
      const code = requestUrl.searchParams.get('code');
      const returnedState = requestUrl.searchParams.get('state');

      const finish = (message: string, failure?: Error) => {
        res.writeHead(failure ? 400 : 200, { 'Content-Type': 'text/plain' }).end(message);
        server.close();
        failure ? reject(failure) : resolve(code as string);
      };

      if (error) {
        finish(`Authorization failed: ${error}`, new Error(`Jobber returned error=${error}`));
      } else if (returnedState !== state) {
        finish('State mismatch — aborting.', new Error('OAuth state mismatch'));
      } else if (!code) {
        finish('No code in callback.', new Error('No authorization code in callback'));
      } else {
        finish('Authorized. You can close this tab and return to the terminal.');
      }
    });

    server.on('error', reject);
    server.listen(listenPort, () => {
      console.log(`Waiting for the redirect on port ${listenPort}...`);
    });
  });
}

/** Non-localhost redirect URI: the user pastes the code from the address bar. */
async function promptForCode(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(
      'Paste the full redirect URL from your browser (or just the code): '
    );
    const code = extractCode(answer.trim());
    if (!code) throw new Error('No authorization code provided');
    return code;
  } finally {
    rl.close();
  }
}

/**
 * Accept whatever is easiest to copy: the whole address bar, or a bare code.
 * Codes are JWTs, so a naive "does it contain ?" check is not enough — parse.
 */
function extractCode(input: string): string {
  if (!input.includes('://')) return input;

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return input;
  }

  const error = parsed.searchParams.get('error');
  if (error) {
    throw new Error(`Jobber returned error=${error} instead of an authorization code`);
  }

  const returnedState = parsed.searchParams.get('state');
  if (returnedState && returnedState !== state) {
    throw new Error('OAuth state mismatch — the redirect URL is from a different attempt');
  }

  return parsed.searchParams.get('code') ?? '';
}

function openInBrowser(target: string): void {
  const opener =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(opener, [target], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' })
      .unref();
  } catch {
    // Printing the URL above is enough.
  }
}
