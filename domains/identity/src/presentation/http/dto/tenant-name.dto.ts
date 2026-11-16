import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';
import { IDENTITY_LIMITS } from '../../../identity.constants.js';
import { TrimString } from '../../shared/transforms.js';

/** Body of `POST /v1/tenants` and `PATCH /v1/tenant`. */
export class TenantNameDto {
  @ApiProperty({ example: 'Acme', minLength: 1, maxLength: IDENTITY_LIMITS.TENANT_NAME_MAX_LENGTH })
  @TrimString()
  @IsString()
  @Length(1, IDENTITY_LIMITS.TENANT_NAME_MAX_LENGTH)
  name: string;
}
