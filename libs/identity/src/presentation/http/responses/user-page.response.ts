import type { UserPage } from '@app/contracts';
import { ApiProperty } from '@nestjs/swagger';
import { Exclude, Expose, Type } from 'class-transformer';
import { UserResponse } from './user.response.js';

@Exclude()
export class UserPageResponse {
  @Expose()
  @Type(() => UserResponse)
  @ApiProperty({ type: () => [UserResponse] })
  items: UserResponse[];

  @Expose()
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Pass as `cursor` to get the next page; `null` on the last page.',
  })
  nextCursor: string | null;

  static from(page: UserPage): UserPageResponse {
    return Object.assign(new UserPageResponse(), {
      items: page.items.map((user) => UserResponse.from(user)),
      nextCursor: page.nextCursor ?? null,
    });
  }
}
