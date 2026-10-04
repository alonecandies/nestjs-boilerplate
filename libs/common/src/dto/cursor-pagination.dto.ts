import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { MAX_CURSOR_LENGTH } from '../utils/cursor.util.js';

export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 100;

/**
 * Keyset (cursor) pagination query: `?limit=20&cursor=<opaque>`. Keyset instead of OFFSET keeps
 * page N as cheap as page 1 on large tables. Swagger-free on purpose (`@app/common` has no
 * `@nestjs/swagger` dep): presentation DTOs extend it and add `@ApiPropertyOptional()`.
 * Every field carries a class-validator decorator — the global pipe (`whitelist` +
 * `forbidNonWhitelisted`) rejects undecorated fields.
 */
export class CursorPaginationQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_LIMIT)
  limit: number = DEFAULT_PAGE_LIMIT;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_CURSOR_LENGTH)
  cursor?: string;
}

/** One page of a keyset-paginated list; `nextCursor === null` means this is the last page. */
export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}
