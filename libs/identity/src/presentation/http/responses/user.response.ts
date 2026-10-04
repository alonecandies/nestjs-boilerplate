import { Role } from '@app/auth';
import type { User } from '@app/contracts';
import { ApiProperty } from '@nestjs/swagger';
import { Exclude, Expose } from 'class-transformer';
import { toUserView } from '../../shared/user-view.js';

/**
 * Public user representation. `@Exclude()` on the class + `@Expose()` per field = allow-list:
 * the controller-level `ClassSerializerInterceptor` emits only these properties, whatever else
 * ends up on the instance.
 */
@Exclude()
export class UserResponse {
  @Expose()
  @ApiProperty({ format: 'uuid', example: '01994f6c-1c3a-7b4e-9f00-5d1e2a3b4c5d' })
  id: string;

  @Expose()
  @ApiProperty({ format: 'email', example: 'ada@example.com' })
  email: string;

  @Expose()
  @ApiProperty({ example: 'Ada Lovelace' })
  displayName: string;

  @Expose()
  @ApiProperty({ enum: Role, enumName: 'Role', isArray: true, example: [Role.User] })
  roles: Role[];

  @Expose()
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @Expose()
  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;

  static from(user: User): UserResponse {
    return Object.assign(new UserResponse(), toUserView(user));
  }
}
