/**
 * Generic OpenID Connect (OIDC) authentication module.
 *
 * Supports auto-discovery, authorization redirects, token exchange,
 * dynamic role/team mapping, and automatic user registration.
 */

import { randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { nanoid } from 'nanoid';
import { config } from '../config.js';
import { pool } from '../db/index.js';
import { redis } from '../storage/redis.js';

export interface OidcConfiguration {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
  jwks_uri?: string;
  end_session_endpoint?: string;
}

export interface OidcTokens {
  access_token: string;
  id_token?: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

export interface OidcUserProfile {
  sub: string;
  email: string;
  name?: string | null;
  rawClaims: Record<string, unknown>;
}

export interface OidcStateData {
  nonce: string;
  redirectUri: string;
  returnTo?: string;
  createdAt: number;
}

// In-memory cache for OIDC provider discovery metadata
let cachedDiscovery: { config: OidcConfiguration; fetchedAt: number } | null = null;
const DISCOVERY_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// In-memory state store fallback if Redis is temporarily unavailable
const inMemoryStates = new Map<string, { data: OidcStateData; expiresAt: number }>();

/**
 * Fetch and cache the OIDC discovery document (.well-known/openid-configuration).
 */
export async function getOidcConfiguration(): Promise<OidcConfiguration> {
  if (!config.oidcIssuerUrl) {
    throw new Error('OIDC is not properly configured: OIDC_ISSUER_URL is missing');
  }

  const now = Date.now();
  if (cachedDiscovery && now - cachedDiscovery.fetchedAt < DISCOVERY_CACHE_TTL_MS) {
    return cachedDiscovery.config;
  }

  const issuerBase = config.oidcIssuerUrl.replace(/\/+$/, '');
  const discoveryUrl = `${issuerBase}/.well-known/openid-configuration`;

  const res = await fetch(discoveryUrl, {
    headers: { Accept: 'application/json' },
  });

  if (!res.ok) {
    throw new Error(
      `Failed to fetch OIDC discovery document from ${discoveryUrl}: HTTP ${res.status}`
    );
  }

  const data = (await res.json()) as OidcConfiguration;
  if (!data.authorization_endpoint || !data.token_endpoint) {
    throw new Error(
      `Invalid OIDC discovery response from ${discoveryUrl}: missing authorization or token endpoint`
    );
  }

  cachedDiscovery = { config: data, fetchedAt: now };
  return data;
}

/**
 * Generate and store an OIDC state & nonce for CSRF mitigation.
 */
export async function createOidcState(
  redirectUri: string,
  returnTo?: string
): Promise<{ state: string; nonce: string }> {
  const state = randomBytes(24).toString('hex');
  const nonce = randomBytes(24).toString('hex');
  const stateData: OidcStateData = {
    nonce,
    redirectUri,
    returnTo,
    createdAt: Date.now(),
  };

  const ttlSecs = 600; // 10 minutes

  if (redis) {
    try {
      await redis.set(`oidc:state:${state}`, JSON.stringify(stateData), 'EX', ttlSecs);
    } catch (err) {
      console.warn('Failed to store OIDC state in Redis, falling back to memory:', err);
      inMemoryStates.set(state, { data: stateData, expiresAt: Date.now() + ttlSecs * 1000 });
    }
  } else {
    inMemoryStates.set(state, { data: stateData, expiresAt: Date.now() + ttlSecs * 1000 });
  }

  return { state, nonce };
}

/**
 * Validate and consume an OIDC state token (ensures single-use).
 */
export async function consumeOidcState(state: string): Promise<OidcStateData | null> {
  if (!state) return null;

  if (redis) {
    try {
      const key = `oidc:state:${state}`;
      const raw = await redis.get(key);
      if (raw) {
        await redis.del(key);
        return JSON.parse(raw) as OidcStateData;
      }
    } catch (err) {
      console.warn('Failed to read OIDC state from Redis:', err);
    }
  }

  const mem = inMemoryStates.get(state);
  if (mem) {
    inMemoryStates.delete(state);
    if (Date.now() <= mem.expiresAt) {
      return mem.data;
    }
  }

  return null;
}

/**
 * Build the authorization URL for user login redirection.
 */
export async function getOidcAuthorizationUrl(options: {
  redirectUri?: string;
  returnTo?: string;
  customScopes?: string;
}): Promise<{ url: string; state: string; nonce: string }> {
  const oidcConfig = await getOidcConfiguration();
  const redirectUri = options.redirectUri || config.oidcRedirectUri || '';

  if (!config.oidcClientId) {
    throw new Error('OIDC_CLIENT_ID is not configured');
  }

  const { state, nonce } = await createOidcState(redirectUri, options.returnTo);

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.oidcClientId,
    redirect_uri: redirectUri,
    scope: options.customScopes || config.oidcScopes,
    state,
    nonce,
  });

  const authUrl = `${oidcConfig.authorization_endpoint}?${params.toString()}`;
  return { url: authUrl, state, nonce };
}

/**
 * Exchange an authorization code for OIDC tokens.
 */
export async function exchangeOidcCode(code: string, redirectUri: string): Promise<OidcTokens> {
  const oidcConfig = await getOidcConfiguration();

  if (!config.oidcClientId || !config.oidcClientSecret) {
    throw new Error('OIDC client credentials (OIDC_CLIENT_ID, OIDC_CLIENT_SECRET) are missing');
  }

  const bodyParams = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: config.oidcClientId,
    client_secret: config.oidcClientSecret,
  });

  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  };

  // Basic Auth header support for IdPs that require client authentication in headers
  const basicAuth = Buffer.from(`${config.oidcClientId}:${config.oidcClientSecret}`).toString(
    'base64'
  );
  headers['Authorization'] = `Basic ${basicAuth}`;

  const res = await fetch(oidcConfig.token_endpoint, {
    method: 'POST',
    headers,
    body: bodyParams.toString(),
  });

  if (!res.ok) {
    const errorBody = await res.text().catch(() => '');
    throw new Error(`Token exchange failed (HTTP ${res.status}): ${errorBody}`);
  }

  return (await res.json()) as OidcTokens;
}

/**
 * Extract user claims and fetch userinfo endpoint if available.
 */
export async function fetchOidcUserProfile(tokens: OidcTokens): Promise<OidcUserProfile> {
  const oidcConfig = await getOidcConfiguration();
  let claims: Record<string, unknown> = {};

  // 1. Decode ID token payload if available
  if (tokens.id_token) {
    const decoded = jwt.decode(tokens.id_token);
    if (decoded && typeof decoded === 'object') {
      claims = { ...decoded };
    }
  }

  // 2. Fetch UserInfo endpoint if present and access token provided
  if (oidcConfig.userinfo_endpoint && tokens.access_token) {
    try {
      const userinfoRes = await fetch(oidcConfig.userinfo_endpoint, {
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
          Accept: 'application/json',
        },
      });

      if (userinfoRes.ok) {
        const userinfoData = (await userinfoRes.json()) as Record<string, unknown>;
        claims = { ...claims, ...userinfoData };
      }
    } catch (err) {
      console.warn('Failed to fetch OIDC userinfo endpoint:', err);
    }
  }

  const sub =
    typeof claims.sub === 'string' ? claims.sub : typeof claims.id === 'string' ? claims.id : '';

  const emailRaw =
    typeof claims.email === 'string'
      ? claims.email
      : typeof claims.preferred_username === 'string'
        ? claims.preferred_username
        : typeof claims.upn === 'string'
          ? claims.upn
          : '';
  const email = emailRaw.toLowerCase().trim();

  if (!email) {
    throw new Error('OIDC provider did not return an email address in claims');
  }

  const name =
    (typeof claims.name === 'string' && claims.name) ||
    (typeof claims.preferred_username === 'string' && claims.preferred_username) ||
    email.split('@')[0] ||
    'User';

  return {
    sub,
    email,
    name,
    rawClaims: claims,
  };
}

/**
 * Extract nested claims using dot notation (e.g., "realm_access.roles", "groups", "roles").
 */
export function extractRolesFromClaims(
  claims: Record<string, unknown>,
  claimPath: string
): string[] {
  if (!claimPath) return [];

  const parts = claimPath.split('.');
  let current: unknown = claims;

  for (const part of parts) {
    if (current && typeof current === 'object' && part in (current as Record<string, unknown>)) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return [];
    }
  }

  if (Array.isArray(current)) {
    return current
      .map((item) => (typeof item === 'string' ? item.trim() : String(item).trim()))
      .filter(Boolean);
  }

  if (typeof current === 'string') {
    return current
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
}

/**
 * Map user's OIDC roles/groups against the configured admin roles list.
 */
export function mapOidcRolesToRole(
  userRoles: string[],
  adminRoles: string[],
  defaultRole: 'admin' | 'user' = 'user'
): 'admin' | 'user' {
  if (!adminRoles || adminRoles.length === 0) {
    return defaultRole;
  }

  const normalizedAdminRoles = new Set(adminRoles.map((r) => r.toLowerCase().trim()));

  for (const role of userRoles) {
    if (normalizedAdminRoles.has(role.toLowerCase().trim())) {
      return 'admin';
    }
  }

  return defaultRole;
}

/**
 * Find or auto-register a user in PostgreSQL based on OIDC profile and calculated role.
 */
export async function findOrCreateOidcUser(
  profile: OidcUserProfile,
  role: 'admin' | 'user'
): Promise<{ id: string; email: string; name: string | null; role: 'admin' | 'user' }> {
  // 1. Look up existing user by oidc_sub or email
  const result = await pool.query<{
    id: string;
    email: string;
    name: string | null;
    role: string;
  }>(
    'SELECT id, email, name, role FROM users WHERE (auth_provider = $1 AND oidc_sub = $2) OR email = $3',
    ['oidc', profile.sub, profile.email]
  );

  const existing = result.rows[0];
  if (existing) {
    // Update role and details on login
    await pool.query(
      `UPDATE users
       SET role = $1,
           name = COALESCE($2, name),
           auth_provider = 'oidc',
           oidc_sub = COALESCE($3, oidc_sub),
           modified_at = NOW()
       WHERE id = $4`,
      [role, profile.name, profile.sub, existing.id]
    );

    return {
      id: existing.id,
      email: existing.email,
      name: profile.name || existing.name,
      role,
    };
  }

  // 2. User not found -> Auto-register if enabled
  if (!config.oidcAutoRegister) {
    throw new Error('User does not exist and automatic registration is disabled');
  }

  const newId = nanoid();
  // Use a non-usable password placeholder for OIDC accounts
  const passwordHash = '!oidc';

  await pool.query(
    `INSERT INTO users (id, email, password_hash, name, role, auth_provider, oidc_sub, created_at, modified_at)
     VALUES ($1, $2, $3, $4, $5, 'oidc', $6, NOW(), NOW())`,
    [newId, profile.email, passwordHash, profile.name, role, profile.sub]
  );

  return {
    id: newId,
    email: profile.email,
    name: profile.name || null,
    role,
  };
}
