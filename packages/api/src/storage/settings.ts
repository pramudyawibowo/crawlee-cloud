/**
 * Dynamic System Settings storage module.
 *
 * Persists runtime configuration overrides to PostgreSQL (system_settings table)
 * with transparent fallback to environment variables in config.ts.
 */

import { pool } from '../db/index.js';
import { config } from '../config.js';

export interface OidcSystemSettings {
  enabled: boolean;
  providerName: string;
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  redirectUri?: string;
  rolesClaim: string;
  adminRoles: string[];
  defaultRole: 'admin' | 'user';
  autoRegister: boolean;
}

export interface ExecutionSystemSettings {
  maxConcurrentRuns: number;
  defaultMemoryMb: number;
  defaultTimeoutSecs: number;
  apifyCuPrice: number;
}

/**
 * Retrieve a JSON setting from system_settings table, with fallback to default value.
 */
export async function getSystemSetting<T>(key: string, fallback: T): Promise<T> {
  try {
    const result = await pool.query<{ value: T }>(
      'SELECT value FROM system_settings WHERE key = $1',
      [key]
    );

    const row = result?.rows?.[0];
    if (row && row.value !== undefined && row.value !== null) {
      return { ...fallback, ...row.value };
    }
  } catch (err) {
    console.warn(`[Settings] Failed to load setting "${key}" from database, using fallback:`, err);
  }

  return fallback;
}

/**
 * Upsert a setting into the system_settings table.
 */
export async function setSystemSetting<T>(key: string, value: T, userId?: string): Promise<void> {
  await pool.query(
    `INSERT INTO system_settings (key, value, updated_at, updated_by)
     VALUES ($1, $2, NOW(), $3)
     ON CONFLICT (key) DO UPDATE
     SET value = EXCLUDED.value,
         updated_at = NOW(),
         updated_by = EXCLUDED.updated_by`,
    [key, JSON.stringify(value), userId || null]
  );
}

/**
 * Get effective OIDC settings (database overlay merged over .env config).
 */
export async function getEffectiveOidcConfig(): Promise<OidcSystemSettings> {
  const envDefault: OidcSystemSettings = {
    enabled: config.oidcEnabled,
    providerName: config.oidcProviderName || 'SSO',
    issuerUrl: config.oidcIssuerUrl || '',
    clientId: config.oidcClientId || '',
    clientSecret: config.oidcClientSecret || '',
    scopes: config.oidcScopes || 'openid email profile groups',
    redirectUri: config.oidcRedirectUri,
    rolesClaim: config.oidcRolesClaim || 'roles',
    adminRoles: config.oidcAdminRoles || ['admin', 'crawlee-admins', 'devops'],
    defaultRole: config.oidcDefaultRole || 'user',
    autoRegister: config.oidcAutoRegister ?? true,
  };

  return getSystemSetting<OidcSystemSettings>('auth.oidc', envDefault);
}

/**
 * Get effective execution settings (database overlay merged over .env config).
 */
export async function getEffectiveExecutionConfig(): Promise<ExecutionSystemSettings> {
  const envDefault: ExecutionSystemSettings = {
    maxConcurrentRuns: parseInt(process.env.MAX_CONCURRENT_RUNS || '10', 10),
    defaultMemoryMb: parseInt(process.env.DEFAULT_MEMORY_MB || '1024', 10),
    defaultTimeoutSecs: parseInt(process.env.DEFAULT_TIMEOUT_SECS || '3600', 10),
    apifyCuPrice: config.apifyCuPrice ?? 0.4,
  };

  return getSystemSetting<ExecutionSystemSettings>('system.execution', envDefault);
}
