import { makeAuthUser, PERMISSIONS_KEY, PermissionsGuard, Role } from '@app/auth';
import { PermissionDeniedException } from '@app/common';
import { storageConfig } from '@app/config';
import { InMemoryStorageService } from '@app/storage';
import { Reflector } from '@nestjs/core';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host.js';
import { GraphQLSchemaBuilderModule, GraphQLSchemaFactory, Query, Resolver } from '@nestjs/graphql';
import { Test } from '@nestjs/testing';
import { validate } from 'class-validator';
import type { GraphQLSchema } from 'graphql';
import { mapValues } from 'lodash-es';
import { beforeAll, describe, expect, it } from 'vitest';
import { FilesService } from '../../application/files.service.js';
import { FileTooLargeException } from '../../domain/files.errors.js';
import { CreateUploadUrlInput } from './create-upload-url.input.js';
import { FilesResolver } from './files.resolver.js';

const input = (overrides: Partial<CreateUploadUrlInput> = {}): CreateUploadUrlInput =>
  Object.assign(new CreateUploadUrlInput(), {
    filename: 'Avatar.PNG',
    contentType: 'image/png',
    contentLength: 512,
    ...overrides,
  });

/** A schema needs a Query root; the files context only contributes a mutation. */
@Resolver()
class PingResolver {
  @Query(() => String)
  ping(): string {
    return 'pong';
  }
}

/** `{ field: 'Type!' }` of an object/input type, read without importing graphql's runtime. */
function fieldsOf(schema: GraphQLSchema, typeName: string): Record<string, string> {
  const type = schema.getType(typeName);
  if (type === undefined || !('getFields' in type)) throw new Error(`no fields on ${typeName}`);
  return mapValues(type.getFields(), (field) => String(field.type));
}

describe('FilesResolver', () => {
  describe('code-first schema', () => {
    let schema: GraphQLSchema;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [GraphQLSchemaBuilderModule],
      }).compile();
      // Not skipCheck: the factory runs an introspection query, i.e. validates the whole schema.
      schema = await moduleRef.get(GraphQLSchemaFactory).create([PingResolver, FilesResolver]);
    });

    it('exposes Mutation.createUploadUrl(input: CreateUploadUrlInput!): PresignedUpload!', () => {
      const field = schema.getMutationType()?.getFields()['createUploadUrl'];
      expect(String(field?.type)).toBe('PresignedUpload!');
      expect(field?.args.map((arg) => `${arg.name}: ${String(arg.type)}`)).toEqual([
        'input: CreateUploadUrlInput!',
      ]);
    });

    it('types the input and the payload', () => {
      expect(fieldsOf(schema, 'CreateUploadUrlInput')).toEqual({
        filename: 'String!',
        contentType: 'String!',
        contentLength: 'Int!',
      });
      expect(fieldsOf(schema, 'PresignedUpload')).toEqual({
        key: 'String!',
        filename: 'String!',
        url: 'String!',
        method: 'String!',
        headers: '[PresignedUploadHeader!]!',
        expiresAt: 'DateTime!',
      });
      expect(fieldsOf(schema, 'PresignedUploadHeader')).toEqual({
        name: 'String!',
        value: 'String!',
      });
    });
  });

  describe('createUploadUrl', () => {
    const user = makeAuthUser({ roles: [Role.User] });
    const config = storageConfig.parse({ STORAGE_MAX_UPLOAD_BYTES: '1024' });
    const resolver = new FilesResolver(new FilesService(new InMemoryStorageService(), config));

    it('maps the presigned upload to the GraphQL model (headers as a list)', async () => {
      const model = await resolver.createUploadUrl(user, input({ contentType: 'IMAGE/PNG' }));

      expect(model).toEqual({
        key: expect.stringMatching(new RegExp(`^users/${user.id}/[0-9a-f-]{36}-avatar\\.png$`)),
        filename: 'avatar.png',
        url: expect.stringContaining('method=PUT'),
        method: 'PUT',
        headers: [{ name: 'content-type', value: 'image/png' }],
        expiresAt: expect.any(Date),
      });
    });

    it('surfaces the domain 413 (GraphQL extensions.code FILE_TOO_LARGE)', async () => {
      await expect(
        resolver.createUploadUrl(user, input({ contentLength: 1025 })),
      ).rejects.toBeInstanceOf(FileTooLargeException);
    });
  });

  describe('input validation (global class-validator pipe)', () => {
    it('accepts a valid input, whatever the content-type case', async () => {
      await expect(validate(input())).resolves.toEqual([]);
      await expect(validate(input({ contentType: 'Application/PDF' }))).resolves.toEqual([]);
    });

    it.each([
      ['filename', { filename: '' }],
      ['filename', { filename: 'x'.repeat(256) }],
      ['contentType', { contentType: 'image/svg+xml' }],
      ['contentType', { contentType: 'text/plain; charset=utf-8' }],
      ['contentLength', { contentLength: 0 }],
      ['contentLength', { contentLength: 1.5 }],
    ])('rejects a bad %s', async (property, overrides) => {
      const errors = await validate(input(overrides));
      expect(errors.map((error) => error.property)).toEqual([property]);
    });
  });

  describe('RBAC', () => {
    const guard = new PermissionsGuard(new Reflector());
    const graphqlContext = (user: unknown): ExecutionContextHost => {
      const host = new ExecutionContextHost(
        [{}, {}, { req: { headers: {}, user } }, {}],
        FilesResolver,
        FilesResolver.prototype.createUploadUrl,
      );
      host.setType('graphql');
      return host;
    };

    it('requires files:write', () => {
      expect(Reflect.getMetadata(PERMISSIONS_KEY, FilesResolver.prototype.createUploadUrl)).toEqual(
        {
          permissions: ['files:write'],
          mode: 'all',
        },
      );
    });

    it('lets users through and rejects a user without files:write (403)', () => {
      expect(guard.canActivate(graphqlContext(makeAuthUser({ roles: [Role.User] })))).toBe(true);
      expect(() => guard.canActivate(graphqlContext(makeAuthUser({ roles: [] })))).toThrow(
        PermissionDeniedException,
      );
    });
  });
});
