import { describe, expect, it } from 'bun:test';
import type { AppConfig } from '../types';
import {
  DEFAULT_HTTP_HOST,
  getHttpServerExposureError,
  isLoopbackHost,
  isProductionRuntime,
} from './index';

function createServerConfig(
  host: string,
  auth: Partial<AppConfig['server']['auth']> = {},
): AppConfig['server'] {
  return {
    port: 3000,
    host,
    auth: {
      required: auth.required ?? false,
      tokens: auth.tokens ?? [],
      cookieName: auth.cookieName ?? 'sage_http_token',
    },
  };
}

describe('config HTTP exposure policy', () => {
  it('defaults HTTP binding to loopback', () => {
    expect(DEFAULT_HTTP_HOST).toBe('127.0.0.1');
  });

  it('classifies loopback hosts', () => {
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('127.2.3.4')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('::')).toBe(false);
    expect(isLoopbackHost('host.docker.internal')).toBe(false);
  });

  it('detects production runtime from launch environment', () => {
    expect(isProductionRuntime({ NODE_ENV: 'production' })).toBe(true);
    expect(isProductionRuntime({ SAGE_INSTANCE: 'sage' })).toBe(true);
    expect(isProductionRuntime({ PROCESS_NAME: 'sage' })).toBe(true);
    expect(isProductionRuntime({})).toBe(true);
    expect(isProductionRuntime({ NODE_ENV: 'development', SAGE_INSTANCE: 'sage-dev' })).toBe(false);
    expect(isProductionRuntime({ NODE_ENV: 'test' })).toBe(false);
  });

  it('fails production startup on non-loopback host without HTTP token', () => {
    const error = getHttpServerExposureError(
      createServerConfig('0.0.0.0'),
      { NODE_ENV: 'production' },
    );

    expect(error).toContain('non-loopback host 0.0.0.0');
  });

  it('allows production loopback startup without HTTP token', () => {
    expect(getHttpServerExposureError(
      createServerConfig('127.0.0.1'),
      { NODE_ENV: 'production' },
    )).toBeNull();
  });

  it('allows explicit production non-loopback host when a token enables auth', () => {
    expect(getHttpServerExposureError(
      createServerConfig('0.0.0.0', { tokens: ['admin-token'] }),
      { NODE_ENV: 'production' },
    )).toBeNull();
  });

  it('fails startup when auth is required but no HTTP token is configured', () => {
    const error = getHttpServerExposureError(
      createServerConfig('127.0.0.1', { required: true }),
      { NODE_ENV: 'development' },
    );

    expect(error).toContain('SAGE_HTTP_AUTH_REQUIRED');
  });
});
