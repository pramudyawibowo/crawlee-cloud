import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveDbSsl } from '../src/db/ssl.js';

describe('resolveDbSsl', () => {
  const origDbSsl = process.env.DB_SSL;
  const origNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    delete process.env.DB_SSL;
    delete process.env.NODE_ENV;
  });

  afterEach(() => {
    if (origDbSsl !== undefined) process.env.DB_SSL = origDbSsl;
    else delete process.env.DB_SSL;
    if (origNodeEnv !== undefined) process.env.NODE_ENV = origNodeEnv;
    else delete process.env.NODE_ENV;
  });

  it('disables SSL when sslmode=disable is in the URL', () => {
    const res = resolveDbSsl(
      'postgresql://postgres:postgres@localhost:6432/crawlee_cloud?sslmode=disable'
    );
    expect(res).toBe(false);
  });

  it('disables SSL when sslmode=allow is in the URL', () => {
    const res = resolveDbSsl(
      'postgresql://postgres:postgres@localhost:6432/crawlee_cloud?sslmode=allow'
    );
    expect(res).toBe(false);
  });

  it('enables SSL with rejectUnauthorized: false when sslmode=require is in the URL', () => {
    const res = resolveDbSsl(
      'postgresql://postgres:postgres@db.example.com:6432/crawlee_cloud?sslmode=require'
    );
    expect(res).toEqual({ rejectUnauthorized: false });
  });

  it('enables SSL with rejectUnauthorized: false when sslmode=no-verify is in the URL', () => {
    const res = resolveDbSsl(
      'postgresql://postgres:postgres@db.example.com:6432/crawlee_cloud?sslmode=no-verify'
    );
    expect(res).toEqual({ rejectUnauthorized: false });
  });

  it('DB_SSL=false explicitly disables SSL even in production', () => {
    process.env.DB_SSL = 'false';
    const res = resolveDbSsl(
      'postgresql://postgres:postgres@db.example.com:6432/crawlee_cloud',
      'production'
    );
    expect(res).toBe(false);
  });

  it('DB_SSL=true explicitly enables SSL even in development', () => {
    process.env.DB_SSL = 'true';
    const res = resolveDbSsl(
      'postgresql://postgres:postgres@localhost:6432/crawlee_cloud',
      'development'
    );
    expect(res).toEqual({ rejectUnauthorized: false });
  });

  it('in production, does not force SSL on localhost, postgres, or pgbouncer container host', () => {
    expect(
      resolveDbSsl('postgresql://postgres:postgres@localhost:6432/crawlee_cloud', 'production')
    ).toBeUndefined();
    expect(
      resolveDbSsl('postgresql://postgres:postgres@127.0.0.1:6432/crawlee_cloud', 'production')
    ).toBeUndefined();
    expect(
      resolveDbSsl('postgresql://postgres:postgres@postgres:5432/crawlee_cloud', 'production')
    ).toBeUndefined();
    expect(
      resolveDbSsl('postgresql://postgres:postgres@pgbouncer:6432/crawlee_cloud', 'production')
    ).toBeUndefined();
    expect(
      resolveDbSsl(
        'postgresql://postgres:postgres@my-internal-bouncer:6432/crawlee_cloud',
        'production'
      )
    ).toBeUndefined();
  });

  it('in production, does not force SSL on private IP addresses or port 6432', () => {
    expect(
      resolveDbSsl('postgresql://postgres:postgres@192.168.1.50:6432/crawlee_cloud', 'production')
    ).toBeUndefined();
    expect(
      resolveDbSsl('postgresql://postgres:postgres@10.0.0.5:6432/crawlee_cloud', 'production')
    ).toBeUndefined();
    expect(
      resolveDbSsl('postgresql://postgres:postgres@172.20.0.2:6432/crawlee_cloud', 'production')
    ).toBeUndefined();
    expect(
      resolveDbSsl(
        'postgresql://postgres:postgres@custom-db.internal:6432/crawlee_cloud',
        'production'
      )
    ).toBeUndefined();
  });

  it('in production, defaults to SSL for remote cloud hosts without sslmode', () => {
    const res = resolveDbSsl(
      'postgresql://user:pass@db-postgresql-nyc3-12345.b.db.ondigitalocean.com:25061/defaultdb',
      'production'
    );
    expect(res).toEqual({ rejectUnauthorized: false });
  });

  it('sslmode=disable overrides production remote host default', () => {
    const res = resolveDbSsl(
      'postgresql://user:pass@remote-pgbouncer.example.com:6432/defaultdb?sslmode=disable',
      'production'
    );
    expect(res).toBe(false);
  });
});
