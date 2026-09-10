/**
 * Database SSL configuration resolver for runner.
 * Handles PgBouncer and direct PostgreSQL connections with or without SSL.
 */

export type DbSslConfig = boolean | { rejectUnauthorized: boolean } | undefined;

/**
 * Checks whether a hostname or port points to a private/internal network or standard PgBouncer port.
 */
function isInternalOrPrivateHost(host: string, port?: string): boolean {
  const h = host.toLowerCase().trim();
  if (
    h === 'localhost' ||
    h === '127.0.0.1' ||
    h === '::1' ||
    h === 'postgres' ||
    h === 'pgbouncer' ||
    h === 'db'
  ) {
    return true;
  }
  // Host with no dot (Docker container names or k8s local service names, e.g. "api", "pgbouncer-service")
  if (!h.includes('.')) {
    return true;
  }
  // Standard PgBouncer port 6432 typically runs without TLS unless configured
  if (port === '6432') {
    return true;
  }
  // IPv4 private ranges: 10.0.0.0/8, 127.0.0.0/8, 192.168.0.0/16
  if (/^(?:10|127|192\.168)\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) {
    return true;
  }
  // 172.16.0.0/12 (Docker bridge default network is typically 172.17.x.x - 172.31.x.x)
  const match172 = /^172\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(h);
  const secondOctet = match172?.[1];
  if (secondOctet) {
    const octet = parseInt(secondOctet, 10);
    if (octet >= 16 && octet <= 31) {
      return true;
    }
  }
  return false;
}

/**
 * Resolves the appropriate pg.Pool ssl option based on DATABASE_URL,
 * DB_SSL environment variable, and NODE_ENV.
 */
export function resolveDbSsl(databaseUrl: string, nodeEnv?: string): DbSslConfig {
  const dbSslEnv = process.env.DB_SSL?.toLowerCase().trim();
  if (dbSslEnv === 'false' || dbSslEnv === '0' || dbSslEnv === 'off' || dbSslEnv === 'disable') {
    return false;
  }
  if (dbSslEnv === 'true' || dbSslEnv === '1' || dbSslEnv === 'on' || dbSslEnv === 'require') {
    return { rejectUnauthorized: false };
  }

  // Parse sslmode from databaseUrl
  try {
    const url = new URL(databaseUrl.replace(/^postgres(ql)?:\/\//i, 'http://'));
    const sslmode = url.searchParams.get('sslmode')?.toLowerCase().trim();

    if (sslmode === 'disable' || sslmode === 'allow') {
      return false;
    }
    if (
      sslmode === 'require' ||
      sslmode === 'prefer' ||
      sslmode === 'verify-ca' ||
      sslmode === 'verify-full' ||
      sslmode === 'no-verify'
    ) {
      return { rejectUnauthorized: false };
    }
  } catch {
    // Fallback if URL parsing fails
    if (databaseUrl.includes('sslmode=disable') || databaseUrl.includes('sslmode=allow')) {
      return false;
    }
    if (databaseUrl.includes('sslmode=')) {
      return { rejectUnauthorized: false };
    }
  }

  const isProd = (nodeEnv ?? process.env.NODE_ENV) === 'production';
  if (isProd) {
    try {
      const url = new URL(databaseUrl.replace(/^postgres(ql)?:\/\//i, 'http://'));
      const host = url.hostname.toLowerCase();
      const port = url.port;
      // Do not force SSL on internal, private IP, or standard PgBouncer port
      if (isInternalOrPrivateHost(host, port)) {
        return undefined;
      }
    } catch {
      // ignore
    }
    return { rejectUnauthorized: false };
  }

  return undefined;
}
