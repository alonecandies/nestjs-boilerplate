import { Field, InputType } from '@nestjs/graphql';
import { ROLE_VALUES, Role } from '@platform/auth';
import { GraphQLUUID } from '@platform/graphql';
import { ArrayMaxSize, ArrayNotEmpty, ArrayUnique, IsArray, IsEnum, IsUUID } from 'class-validator';
import { RoleEnum } from '../role.enum.js';

@InputType()
export class UpdateUserRolesInput {
  @Field(() => GraphQLUUID)
  @IsUUID('7')
  id: string;

  /** GraphQL already maps `ADMIN` → `'admin'`, so class-validator sees `Role` values. */
  @Field(() => [RoleEnum])
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @ArrayMaxSize(ROLE_VALUES.length)
  @IsEnum(Role, { each: true })
  roles: Role[];
}
