import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { IDENTITY_LIMITS } from '../../../identity.constants.js';
import { TrimString } from '../../shared/transforms.js';

export class StaffSwitchInDto {
  @ApiProperty({
    description: 'Why you enter this tenant (audited, visible to the tenant).',
    maxLength: IDENTITY_LIMITS.SWITCH_IN_REASON_MAX_LENGTH,
    example: 'Support ticket #42: invoice totals are wrong',
  })
  @TrimString()
  @IsString()
  @IsNotEmpty()
  @MaxLength(IDENTITY_LIMITS.SWITCH_IN_REASON_MAX_LENGTH)
  reason: string;
}
