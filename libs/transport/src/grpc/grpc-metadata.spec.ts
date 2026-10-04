import { generateId } from '@app/common';
import { Metadata } from '@grpc/grpc-js';
import { describe, expect, it } from 'vitest';
import { GRPC_METADATA_KEYS } from './grpc.constants.js';
import {
  createErrorTrailers,
  createOutgoingMetadata,
  isGrpcMetadata,
  readErrorTrailers,
  readIncomingMetadata,
  toValidationIssueList,
} from './grpc-metadata.js';

describe('caller metadata', () => {
  it('round-trips request id, correlation id, user and roles', () => {
    const requestId = generateId();
    const correlationId = generateId();
    const metadata = createOutgoingMetadata({
      requestId,
      correlationId,
      userId: 'user-1',
      roles: ['admin', ' user ', 'admin', ''],
    });

    expect(metadata.get(GRPC_METADATA_KEYS.USER_ROLES)).toEqual(['admin,user']);
    expect(readIncomingMetadata(metadata)).toEqual({
      requestId,
      correlationId,
      userId: 'user-1',
      roles: ['admin', 'user'],
    });
  });

  it('omits missing and unsafe values instead of letting grpc-js throw', () => {
    const metadata = createOutgoingMetadata({
      requestId: 'bad id with spaces\n',
      userId: 'ünïcødé',
      roles: [],
    });
    expect(metadata.toJSON()).toEqual({});
    expect(readIncomingMetadata(metadata)).toEqual({ roles: [] });
    expect(createOutgoingMetadata().toJSON()).toEqual({});
  });

  it('ignores unsafe incoming ids (log / header injection)', () => {
    const metadata = new Metadata();
    metadata.set(GRPC_METADATA_KEYS.REQUEST_ID, 'x'.repeat(500));
    metadata.set(GRPC_METADATA_KEYS.CORRELATION_ID, 'a;b');
    metadata.set(GRPC_METADATA_KEYS.USER_ID, '  user-2  ');
    expect(readIncomingMetadata(metadata)).toEqual({ userId: 'user-2', roles: [] });
    expect(readIncomingMetadata(undefined)).toEqual({ roles: [] });
  });

  it('recognises Metadata structurally', () => {
    expect(isGrpcMetadata(new Metadata())).toBe(true);
    expect(isGrpcMetadata({ get: () => [], getMap: () => ({}) })).toBe(true);
    expect(isGrpcMetadata({})).toBe(false);
    expect(isGrpcMetadata(null)).toBe(false);
  });
});

describe('error trailers', () => {
  it('round-trips the domain code and JSON details (binary header)', () => {
    const details = { entity: 'User', id: 'u1', nested: { ok: true } };
    const trailers = createErrorTrailers({ code: 'USER_NOT_FOUND', details });
    expect(trailers).toBeDefined();
    expect(trailers?.get(GRPC_METADATA_KEYS.ERROR_DETAILS)[0]).toBeInstanceOf(Buffer);
    expect(readErrorTrailers(trailers)).toEqual({ code: 'USER_NOT_FOUND', details });
  });

  it('returns undefined when there is nothing to send', () => {
    expect(createErrorTrailers({})).toBeUndefined();
    expect(createErrorTrailers({ details: {} })).toBeUndefined();
    expect(createErrorTrailers({ code: 'not a safe code!' })).toBeUndefined();
  });

  it('truncates long issue lists to stay under the metadata size limit', () => {
    const issues = Array.from({ length: 500 }, (_, index) => ({
      path: `items.${index}.sku`,
      message: 'Too small: expected string to have >=3 characters',
    }));
    const trailers = createErrorTrailers({ code: 'VALIDATION_FAILED', details: { issues } });
    const read = readErrorTrailers(trailers);
    expect(read.code).toBe('VALIDATION_FAILED');
    expect(toValidationIssueList(read.details?.['issues'])).toHaveLength(20);
  });

  it('drops details that cannot be serialized', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(readErrorTrailers(createErrorTrailers({ code: 'X', details: circular }))).toEqual({
      code: 'X',
    });
  });

  it('never throws on foreign or malformed trailers', () => {
    const metadata = new Metadata();
    metadata.set(GRPC_METADATA_KEYS.ERROR_DETAILS, Buffer.from('{not json', 'utf8'));
    metadata.set(GRPC_METADATA_KEYS.ERROR_CODE, 'OK_CODE');
    expect(readErrorTrailers(metadata)).toEqual({ code: 'OK_CODE' });
    expect(readErrorTrailers(undefined)).toEqual({});
    expect(readErrorTrailers('nope')).toEqual({});
  });

  it('narrows issue lists and skips malformed entries', () => {
    expect(
      toValidationIssueList([
        { path: 'a', message: 'bad', code: 'x' },
        { message: 'root problem' },
        { path: 'b' },
        42,
      ]),
    ).toEqual([
      { path: 'a', message: 'bad', code: 'x' },
      { path: '', message: 'root problem' },
    ]);
    expect(toValidationIssueList('nope')).toBeUndefined();
  });
});
