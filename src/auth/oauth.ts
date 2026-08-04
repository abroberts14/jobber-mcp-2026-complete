/**
 * Jobber OAuth 2.0 helpers.
 *
 * Jobber does not issue static API keys. Every request is authenticated with a
 * short-lived (60 minute) access token obtained through the authorization code
 * grant, and refreshed with a rotating refresh token.
 *
 * https://developer.getjobber.com/docs/building_your_app/app_authorization/
 */

import type { JobberTokens } from '../types/jobber.js';

export const DEFAULT_OAUTH_URL = 'https://api.getjobber.com/api/oauth';

/** Refresh this long before the token actually expires, to absorb clock skew. */
const EXPIRY_SKEW_MS = 60_000;

/** Fallback lifetime when Jobber returns neither expires_in nor a decodable exp. */
const FALLBACK_LIFETIME_MS = 55 * 60_000;

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
}

export function authorizeUrl(options: {
  clientId: string;
  redirectUri: string;
  state: string;
  oauthUrl?: string;
}): string {
  const url = new URL(`${options.oauthUrl || DEFAULT_OAUTH_URL}/authorize`);
  url.searchParams.set('client_id', options.clientId);
  url.searchParams.set('redirect_uri', options.redirectUri);
  url.searchParams.set('state', options.state);
  url.searchParams.set('response_type', 'code');
  return url.toString();
}

export async function exchangeCode(options: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  oauthUrl?: string;
}): Promise<JobberTokens> {
  return requestTokens(options.oauthUrl, {
    client_id: options.clientId,
    client_secret: options.clientSecret,
    grant_type: 'authorization_code',
    code: options.code,
    redirect_uri: options.redirectUri,
  });
}

export async function refreshTokens(options: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  oauthUrl?: string;
}): Promise<JobberTokens> {
  const tokens = await requestTokens(options.oauthUrl, {
    client_id: options.clientId,
    client_secret: options.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: options.refreshToken,
  });

  // Reusing the token we sent is a GUESS, and a dangerous one: Jobber's
  // refresh tokens are single-use, so if it did rotate and simply didn't tell
  // us, the token we keep is already spent and the NEXT refresh fails with
  // "The provided refresh token is not valid" — an hour later, far from the
  // cause. Warn loudly so this shows up in logs before it bites.
  if (!tokens.refreshToken) {
    console.error(
      '[jobber-auth] WARNING: refresh response contained no refresh_token. ' +
        'Reusing the previous one, which will fail if Jobber rotated it ' +
        'server-side. If refreshes start failing, re-run `npm run authorize`.'
    );
  }

  return { ...tokens, refreshToken: tokens.refreshToken || options.refreshToken };
}

async function requestTokens(
  oauthUrl: string | undefined,
  params: Record<string, string>
): Promise<JobberTokens> {
  const response = await fetch(`${oauthUrl || DEFAULT_OAUTH_URL}/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams(params).toString(),
  });

  const body = await response.text();

  if (!response.ok) {
    // A dead refresh token is unrecoverable in-process and needs a human, so
    // say what to do rather than leaving an opaque 401 in the tool result.
    const deadToken =
      params.grant_type === 'refresh_token' &&
      /refresh token is not valid|invalid_grant/i.test(body);

    throw new Error(
      `Jobber OAuth error (${params.grant_type}): ${response.status} ${response.statusText} — ${body}` +
        (deadToken
          ? '\nThe stored refresh token is dead and cannot be renewed automatically. ' +
            'Re-run `npm run authorize`, then update JOBBER_REFRESH_TOKEN and clear ' +
            'the token store (/data/tokens.json on the deployed server). ' +
            'Common cause: another process (e.g. a local stdio server) refreshed ' +
            'against the same Jobber app and consumed the single-use token.'
          : '')
    );
  }

  let payload: TokenResponse;
  try {
    payload = JSON.parse(body) as TokenResponse;
  } catch {
    throw new Error(`Jobber OAuth returned a non-JSON response: ${body}`);
  }

  if (!payload.access_token) {
    throw new Error(`Jobber OAuth response contained no access_token: ${body}`);
  }

  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? '',
    expiresAt: resolveExpiry(payload),
  };
}

function resolveExpiry(payload: TokenResponse): number {
  if (typeof payload.expires_in === 'number') {
    return Date.now() + payload.expires_in * 1000 - EXPIRY_SKEW_MS;
  }

  const exp = jwtExpiry(payload.access_token);
  if (exp) return exp - EXPIRY_SKEW_MS;

  return Date.now() + FALLBACK_LIFETIME_MS;
}

/** Expiry (epoch ms, skew-adjusted) of an access token we were handed directly. */
export function accessTokenExpiry(token: string): number | null {
  const exp = jwtExpiry(token);
  return exp === null ? null : exp - EXPIRY_SKEW_MS;
}

/** Jobber access tokens are JWTs; the exp claim is the authoritative lifetime. */
function jwtExpiry(token: string): number | null {
  const segments = token.split('.');
  if (segments.length < 2) return null;

  try {
    const claims = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'));
    return typeof claims.exp === 'number' ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
}
