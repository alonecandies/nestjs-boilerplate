import { ExternalServiceException } from '@app/common';
import type { AuthTokens, User, UserPage } from '@app/contracts';
import { toUserView } from '../shared/user-view.js';
import { AuthPayloadModel } from './models/auth-payload.model.js';
import { UserModel } from './models/user.model.js';
import { UserConnectionModel } from './models/user-connection.model.js';

export function toUserModel(user: User): UserModel {
  return Object.assign(new UserModel(), toUserView(user));
}

export function toAuthPayloadModel(tokens: AuthTokens): AuthPayloadModel {
  if (!tokens.user) throw new ExternalServiceException('Identity returned tokens without a user');
  return Object.assign(new AuthPayloadModel(), {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresIn: tokens.expiresIn,
    tokenType: tokens.tokenType,
    user: toUserModel(tokens.user),
  });
}

export function toUserConnectionModel(page: UserPage): UserConnectionModel {
  return Object.assign(new UserConnectionModel(), {
    items: page.items.map(toUserModel),
    nextCursor: page.nextCursor ?? null,
  });
}
