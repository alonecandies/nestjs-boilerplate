import { ROLE_VALUES, Role } from '@app/auth';
import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayNotEmpty, ArrayUnique, IsArray, IsEnum } from 'class-validator';

export class UpdateUserRolesDto {
  @ApiProperty({ enum: Role, enumName: 'Role', isArray: true, example: [Role.Moderator] })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @ArrayMaxSize(ROLE_VALUES.length)
  @IsEnum(Role, { each: true })
  roles: Role[];
}
