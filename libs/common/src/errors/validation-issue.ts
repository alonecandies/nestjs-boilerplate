import { isObject } from 'lodash-es';

/**
 * One validation problem, the shape used in `ProblemDetails.errors` and
 * `DomainValidationException.details.issues` — identical whichever validator produced it
 * (class-validator, Nest Standard Schema / zod, gRPC zod pipe).
 */
export interface ValidationIssue {
  /** Dot-separated path to the offending field (`''` for the root value). */
  path: string;
  message: string;
  /** Validator-specific rule id (`isEmail`, `too_small`, …) when known. */
  code?: string;
}

/**
 * Structural subset of a Standard Schema / zod issue, so this package needs no dependency on
 * `@standard-schema/spec` and accepts both `StandardSchemaV1.Issue` and `z.core.$ZodIssue`.
 */
export interface IssueLike {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined;
  readonly code?: string | undefined;
}

const segmentToString = (segment: PropertyKey | { readonly key: PropertyKey }): string =>
  String(isObject(segment) ? segment.key : segment);

/** Converts Standard Schema / zod issues into `ValidationIssue`s (`items.0.sku` style paths). */
export function toValidationIssues(issues: readonly IssueLike[]): ValidationIssue[] {
  return issues.map((issue) => {
    const result: ValidationIssue = {
      path: (issue.path ?? []).map(segmentToString).join('.'),
      message: issue.message,
    };
    if (issue.code !== undefined) result.code = issue.code;
    return result;
  });
}
