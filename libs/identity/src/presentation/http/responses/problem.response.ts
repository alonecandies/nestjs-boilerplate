import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** OpenAPI description of the RFC 9457 error body every endpoint returns (`application/problem+json`). */
export class ProblemResponse {
  @ApiProperty({ example: 'https://errors.nestjs-boilerplate.dev/email-taken' })
  type: string;

  @ApiProperty({ example: 'Conflict' })
  title: string;

  @ApiProperty({ example: 409 })
  status: number;

  @ApiPropertyOptional({ example: 'An account with this email already exists' })
  detail?: string;

  @ApiPropertyOptional({ example: '/v1/auth/register' })
  instance?: string;

  @ApiProperty({ example: 'EMAIL_TAKEN', description: 'Stable machine-readable error code.' })
  code: string;

  @ApiPropertyOptional({ example: '01994f6c-1c3a-7b4e-9f00-5d1e2a3b4c5d' })
  requestId?: string;

  @ApiPropertyOptional({
    description: 'Validation issues `{ path, message, code? }`.',
    type: 'array',
    items: { type: 'object' },
  })
  errors?: unknown[];
}
