import { type ArgumentMetadata, BadRequestException } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsEmail, IsString, MinLength, ValidateNested } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CursorPaginationQueryDto } from '../dto/cursor-pagination.dto.js';
import { toProblemDetails } from '../errors/problem-details.js';
import { createStandardSchemaValidationPipe, createValidationPipe } from './validation.js';

class AddressDto {
  @IsString()
  city!: string;
}

class CreateUserDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(2)
  name!: string;

  @ValidateNested()
  @Type(() => AddressDto)
  address!: AddressDto;
}

const body = (
  metatype: ArgumentMetadata['metatype'],
  schema?: ArgumentMetadata['schema'],
): ArgumentMetadata => (schema ? { type: 'body', metatype, schema } : { type: 'body', metatype });

async function rejection(promise: Promise<unknown>): Promise<BadRequestException> {
  const error: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(BadRequestException);
  return error as BadRequestException;
}

describe('createValidationPipe (class-validator)', () => {
  const pipe = createValidationPipe();

  it('transforms valid payloads into DTO instances', async () => {
    const value = await pipe.transform(
      { email: 'a@b.io', name: 'Ada', address: { city: 'London' } },
      body(CreateUserDto),
    );
    expect(value).toBeInstanceOf(CreateUserDto);
    expect((value as CreateUserDto).address).toBeInstanceOf(AddressDto);
  });

  it('reports every issue with dotted paths and rejects unknown fields', async () => {
    const error = await rejection(
      pipe.transform(
        { email: 'nope', name: 'A', address: { city: 1 }, isAdmin: true },
        body(CreateUserDto),
      ),
    );
    const problem = toProblemDetails(error, { exposeInternal: false });
    expect(problem).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
    expect(problem.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'email', code: 'isEmail' }),
        expect.objectContaining({ path: 'name', code: 'minLength' }),
        expect.objectContaining({ path: 'address.city', code: 'isString' }),
        expect.objectContaining({ path: 'isAdmin', code: 'whitelistValidation' }),
      ]),
    );
    // validationError.value: false → the rejected payload is never echoed back.
    expect(JSON.stringify(problem)).not.toContain('nope');
  });

  it('applies CursorPaginationQueryDto defaults and explicit number conversion', async () => {
    const defaults = (await pipe.transform(
      {},
      { type: 'query', metatype: CursorPaginationQueryDto },
    )) as CursorPaginationQueryDto;
    expect(defaults.limit).toBe(20);
    const parsed = (await pipe.transform(
      { limit: '50', cursor: 'abc' },
      { type: 'query', metatype: CursorPaginationQueryDto },
    )) as CursorPaginationQueryDto;
    expect(parsed).toMatchObject({ limit: 50, cursor: 'abc' });
    await rejection(
      pipe.transform({ limit: '500' }, { type: 'query', metatype: CursorPaginationQueryDto }),
    );
  });

  it('leaves parameters that carry a Standard Schema to the other pipe', async () => {
    const schema = z.object({ anything: z.string() });
    const payload = { unexpected: true };
    await expect(pipe.transform(payload, body(CreateUserDto, schema))).resolves.toBe(payload);
  });
});

describe('createStandardSchemaValidationPipe (zod)', () => {
  const pipe = createStandardSchemaValidationPipe();
  const schema = z.object({
    priceId: z.string().min(1),
    quantity: z.coerce.number().int().min(1).max(100).default(1),
  });

  it('returns the schema output (coercion + defaults)', async () => {
    await expect(pipe.transform({ priceId: 'price_1' }, body(Object, schema))).resolves.toEqual({
      priceId: 'price_1',
      quantity: 1,
    });
    await expect(
      pipe.transform({ priceId: 'p', quantity: '3' }, body(Object, schema)),
    ).resolves.toEqual({
      priceId: 'p',
      quantity: 3,
    });
  });

  it('throws a 400 with structured issues', async () => {
    const error = await rejection(
      pipe.transform({ priceId: '', quantity: 0 }, body(Object, schema)),
    );
    expect(toProblemDetails(error, { exposeInternal: false })).toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
      errors: [
        expect.objectContaining({ path: 'priceId' }),
        expect.objectContaining({ path: 'quantity' }),
      ],
    });
  });

  it('is a no-op without a schema', async () => {
    const payload = { a: 1 };
    await expect(pipe.transform(payload, body(Object))).resolves.toBe(payload);
  });
});
