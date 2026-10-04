import { DEFAULT_PAGE_LIMIT, MAX_CURSOR_LENGTH, MAX_PAGE_LIMIT } from '@app/common';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { IDENTITY_LIMITS } from '../../../identity.constants.js';
import { TrimToUndefined } from '../../shared/transforms.js';

export class ListUsersQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: MAX_PAGE_LIMIT, default: DEFAULT_PAGE_LIMIT })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_LIMIT)
  limit: number = DEFAULT_PAGE_LIMIT;

  @ApiPropertyOptional({ description: '`nextCursor` of the previous page.' })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_CURSOR_LENGTH)
  cursor?: string;

  @ApiPropertyOptional({
    description: 'Case-insensitive substring of the email or display name (empty = no filter).',
    minLength: IDENTITY_LIMITS.SEARCH_MIN_LENGTH,
    maxLength: IDENTITY_LIMITS.SEARCH_MAX_LENGTH,
  })
  @IsOptional()
  @TrimToUndefined()
  @IsString()
  @MinLength(IDENTITY_LIMITS.SEARCH_MIN_LENGTH)
  @MaxLength(IDENTITY_LIMITS.SEARCH_MAX_LENGTH)
  search?: string;
}
