import { Args, Mutation, Resolver } from '@nestjs/graphql';
import { type AuthUser, CurrentUser, RequirePermissions } from '@platform/auth';
import { FilesService } from '../../application/files.service.js';
import { FilesPermission } from '../../files.permissions.js';
import { CreateUploadUrlInput } from './create-upload-url.input.js';
import { toPresignedUploadModel } from './files-graphql.mapper.js';
import { PresignedUploadModel } from './presigned-upload.model.js';

/**
 * GraphQL face of the files context. Only the presigned flow is exposed: GraphQL is a poor
 * transport for file bytes (no streaming multipart here by design). Authentication and
 * `files:write` are enforced by the global, context-aware guards; the key is minted under the
 * caller's active tenant (`user.tenantId`) and user.
 */
@Resolver(() => PresignedUploadModel)
export class FilesResolver {
  constructor(private readonly files: FilesService) {}

  @Mutation(() => PresignedUploadModel, {
    description: 'Presigned PUT URL for a direct client → bucket upload (requires files:write)',
  })
  @RequirePermissions(FilesPermission.Write)
  async createUploadUrl(
    @CurrentUser() user: AuthUser,
    @Args('input') input: CreateUploadUrlInput,
  ): Promise<PresignedUploadModel> {
    return toPresignedUploadModel(await this.files.createUploadUrl(user, input));
  }
}
