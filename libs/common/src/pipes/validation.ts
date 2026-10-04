import {
  type ArgumentMetadata,
  BadRequestException,
  HttpStatus,
  StandardSchemaValidationPipe,
  type StandardSchemaValidationPipeOptions,
  ValidationPipe,
  type ValidationPipeOptions,
} from '@nestjs/common';
import * as classTransformer from 'class-transformer';
import type { ValidationError } from 'class-validator';
import * as classValidator from 'class-validator';
import { flatMap } from 'lodash-es';
import { toValidationIssues, type ValidationIssue } from '../errors/validation-issue.js';

/** Response body of both pipes' 400s — `toProblemDetails` renders `errors` as `ProblemDetails.errors`. */
export interface ValidationErrorBody {
  message: string;
  errors: ValidationIssue[];
}

const VALIDATION_MESSAGE = 'Request validation failed';

/** class-validator error tree → flat `ValidationIssue[]` with dotted paths (`address.city`, `items.0.sku`). */
export function flattenValidationErrors(
  errors: readonly ValidationError[],
  parentPath = '',
): ValidationIssue[] {
  return flatMap(errors, (error) => {
    const path = parentPath ? `${parentPath}.${error.property}` : error.property;
    const own = Object.entries(error.constraints ?? {}).map(
      ([code, message]): ValidationIssue => ({ path, message, code }),
    );
    return error.children?.length
      ? [...own, ...flattenValidationErrors(error.children, path)]
      : own;
  });
}

/**
 * Skips parameters that carry a Standard Schema (`@Body({ schema })`) — those belong to
 * `StandardSchemaValidationPipe`; validating them twice would reject every zod-typed body under
 * `forbidNonWhitelisted`.
 */
export class AppValidationPipe extends ValidationPipe {
  protected override toValidate(metadata: ArgumentMetadata): boolean {
    return metadata.schema === undefined && super.toValidate(metadata);
  }
}

/**
 * Global class-validator pipe (REST DTOs + GraphQL `@InputType`s).
 * - `whitelist` + `forbidNonWhitelisted`: unknown fields are rejected, so EVERY DTO/input field
 *   needs ≥1 class-validator decorator (`@IsOptional()` / `@Allow()` at minimum) or it is refused.
 * - `enableImplicitConversion: false`: use explicit `@Type(() => Number)`; implicit conversion
 *   reflects every property (slow) and turns `"false"` into `true`.
 * - `validationError.target/value: false`: never echo the payload back (PII, response size).
 * - validator/transformer packages are passed explicitly → no lazy dynamic import on the first
 *   request and a guaranteed single class-validator metadata storage.
 */
export function createValidationPipe(overrides: ValidationPipeOptions = {}): ValidationPipe {
  return new AppValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    transformOptions: { enableImplicitConversion: false },
    validationError: { target: false, value: false },
    stopAtFirstError: false,
    errorHttpStatusCode: HttpStatus.BAD_REQUEST,
    validatorPackage: classValidator,
    transformerPackage: classTransformer,
    exceptionFactory: (errors: ValidationError[]) =>
      new BadRequestException({
        message: VALIDATION_MESSAGE,
        errors: flattenValidationErrors(errors),
      } satisfies ValidationErrorBody),
    ...overrides,
  });
}

/**
 * Nest 12 native Standard Schema pipe (zod 4): validates params declared as
 * `@Body({ schema })`, `@Query({ schema })`, `@Param('id', { schema })`, `@MessageBody({ schema })`
 * and is a no-op for everything else. Returns the schema OUTPUT (coercions/defaults applied).
 */
export function createStandardSchemaValidationPipe(
  overrides: StandardSchemaValidationPipeOptions = {},
): StandardSchemaValidationPipe {
  return new StandardSchemaValidationPipe({
    transform: true,
    errorHttpStatusCode: HttpStatus.BAD_REQUEST,
    exceptionFactory: (issues) =>
      new BadRequestException({
        message: VALIDATION_MESSAGE,
        errors: toValidationIssues(issues),
      } satisfies ValidationErrorBody),
    ...overrides,
  });
}
