import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';
import { TrimString } from '../../shared/transforms.js';

export class AcceptInvitationDto {
  @ApiProperty({ description: 'The code from the invitation mail', minLength: 43, maxLength: 43 })
  @TrimString()
  @IsString()
  @Length(43, 43)
  token: string;
}
