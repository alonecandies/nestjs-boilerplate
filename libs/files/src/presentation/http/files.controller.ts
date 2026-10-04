import {
  type AuthUser,
  CurrentUser,
  Permission,
  RequireAnyPermission,
  RequirePermissions,
} from '@app/auth';
import { HTTP_HEADERS, Timeout } from '@app/common';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  PayloadTooLargeException,
  Post,
  Query,
  Res,
  SerializeOptions,
  StandardSchemaSerializerInterceptor,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import {
  FileStreamInterceptor,
  type MultipartFileStream,
} from '@nestjs/platform-fastify/multipart';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiPayloadTooLargeResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnsupportedMediaTypeResponse,
} from '@nestjs/swagger';
import { FilesService } from '../../application/files.service.js';
import {
  FileTooLargeException,
  UploadCapacityExceededException,
} from '../../domain/files.errors.js';
import { UPLOAD_FILE_FIELD } from '../../files.constants.js';
import { ApiMultipartFileBody } from './api-multipart-file-body.decorator.js';
import {
  FILE_UPLOAD_MULTIPART_OPTIONS,
  REQUIRED_UPLOAD_FILE_PIPE,
} from './file-upload.constants.js';
import {
  type CreatePresignedUploadBody,
  CreatePresignedUploadBodySchema,
  type FileKeyQuery,
  FileKeyQuerySchema,
} from './files.dto.js';
import {
  type DownloadUrlResponse,
  DownloadUrlResponseSchema,
  type PresignedUploadResponse,
  PresignedUploadResponseSchema,
  type UploadedFileResponse,
  UploadedFileResponseSchema,
} from './files.response.js';
import {
  toDownloadUrlResponse,
  toPresignedUploadResponse,
  toUploadedFileResponse,
} from './files-http.mapper.js';

const PROBLEM = 'RFC 9457 problem+json';

/** The bit of the Fastify reply the upload route touches (`@Res({ passthrough: true })`). */
interface HeaderWritableReply {
  header(name: string, value: string): unknown;
}

/**
 * `/v1/files` — per-user object storage. Keys are `users/{userId}/{uuidv7}-{safeFilename}`; a user
 * may only touch keys under their own prefix unless they hold `files:manage`.
 *
 * Responses are serialized through their zod schemas (`StandardSchemaSerializerInterceptor`,
 * HTTP-only by construction since it sits on this controller).
 */
@ApiTags('Files')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: `Missing, invalid or revoked access token (${PROBLEM})` })
@Controller({ path: 'files', version: '1' })
@UseInterceptors(StandardSchemaSerializerInterceptor)
export class FilesController {
  constructor(private readonly files: FilesService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(Permission.FilesWrite)
  // Bounded by Fastify's requestTimeout and the storage client's own timeouts instead: a 504 from
  // the interceptor would race a client that is still sending the body.
  @Timeout(0)
  @UseInterceptors(FileStreamInterceptor(UPLOAD_FILE_FIELD, FILE_UPLOAD_MULTIPART_OPTIONS))
  @SerializeOptions({ schema: UploadedFileResponseSchema })
  @ApiOperation({
    summary: 'Upload a file',
    description:
      'Streams one multipart file to object storage through the API (never as one whole-file ' +
      'buffer, but each upload holds up to ~15 MiB while in flight). Concurrent streamed uploads ' +
      'are capped per instance (STORAGE_MAX_CONCURRENT_UPLOADS): beyond it, 503 + Retry-After. ' +
      'Prefer presigned uploads for large files.',
  })
  @ApiMultipartFileBody('A single `file` part, at most STORAGE_MAX_UPLOAD_BYTES (default 25 MiB)')
  @ApiCreatedResponse({ description: 'Stored', standardSchema: UploadedFileResponseSchema })
  @ApiBadRequestResponse({
    description: `No file part, extra parts or a malformed body (${PROBLEM})`,
  })
  @ApiForbiddenResponse({ description: `Missing files:write (${PROBLEM})` })
  @ApiPayloadTooLargeResponse({
    description: `FILE_TOO_LARGE; errors[0] states the limit (${PROBLEM})`,
  })
  @ApiUnsupportedMediaTypeResponse({ description: `UNSUPPORTED_FILE_TYPE (${PROBLEM})` })
  @ApiServiceUnavailableResponse({
    description: `UPLOAD_CAPACITY_EXCEEDED: too many uploads in flight; honour Retry-After (${PROBLEM})`,
  })
  async upload(
    @CurrentUser() user: AuthUser,
    @UploadedFile(REQUIRED_UPLOAD_FILE_PIPE) file: MultipartFileStream,
    @Res({ passthrough: true }) reply: HeaderWritableReply,
  ): Promise<UploadedFileResponse> {
    try {
      const uploaded = await this.files.upload(user, {
        filename: file.originalname,
        contentType: file.mimetype,
        body: file.stream,
      });
      return toUploadedFileResponse(uploaded);
    } catch (error) {
      // The multipart parser destroys the stream with Nest's PayloadTooLargeException once
      // limits.fileSize is exceeded; surface it as the context's own 413 (code + limit).
      if (error instanceof PayloadTooLargeException) {
        throw new FileTooLargeException(this.files.maxUploadBytes, UPLOAD_FILE_FIELD, {
          cause: error,
        });
      }
      // The problem+json filter only sets the content type; headers set here survive its reply.
      if (error instanceof UploadCapacityExceededException) {
        reply.header(HTTP_HEADERS.RETRY_AFTER, String(error.retryAfterSec));
      }
      throw error;
    }
  }

  @Post('presigned-uploads')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(Permission.FilesWrite)
  @SerializeOptions({ schema: PresignedUploadResponseSchema })
  @ApiOperation({
    summary: 'Create a presigned upload URL',
    description:
      'Returns a short-lived PUT URL for a direct client → bucket upload. The content type and ' +
      'exact length are signed: the client must send the returned headers verbatim.',
  })
  @ApiCreatedResponse({
    description: 'Presigned PUT',
    standardSchema: PresignedUploadResponseSchema,
  })
  @ApiBadRequestResponse({ description: `Invalid body (${PROBLEM})` })
  @ApiForbiddenResponse({ description: `Missing files:write (${PROBLEM})` })
  @ApiPayloadTooLargeResponse({
    description: `FILE_TOO_LARGE; errors[0] states the limit (${PROBLEM})`,
  })
  async createPresignedUpload(
    @CurrentUser() user: AuthUser,
    @Body({ schema: CreatePresignedUploadBodySchema }) body: CreatePresignedUploadBody,
  ): Promise<PresignedUploadResponse> {
    return toPresignedUploadResponse(await this.files.createUploadUrl(user, body));
  }

  @Get('download-url')
  @RequireAnyPermission(Permission.FilesRead, Permission.FilesManage)
  @SerializeOptions({ schema: DownloadUrlResponseSchema })
  @ApiOperation({
    summary: 'Create a presigned download URL',
    description:
      'Own files only, unless the caller holds files:manage. The URL forces a download ' +
      '(Content-Disposition: attachment).',
  })
  @ApiOkResponse({ description: 'Presigned GET', standardSchema: DownloadUrlResponseSchema })
  @ApiBadRequestResponse({ description: `Missing or malformed key (${PROBLEM})` })
  @ApiForbiddenResponse({ description: `FILE_ACCESS_DENIED: not your file (${PROBLEM})` })
  @ApiNotFoundResponse({ description: `FILE_NOT_FOUND (${PROBLEM})` })
  async createDownloadUrl(
    @CurrentUser() user: AuthUser,
    @Query({ schema: FileKeyQuerySchema }) query: FileKeyQuery,
  ): Promise<DownloadUrlResponse> {
    return toDownloadUrlResponse(await this.files.createDownloadUrl(user, query.key));
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireAnyPermission(Permission.FilesWrite, Permission.FilesManage)
  @ApiOperation({
    summary: 'Delete a file',
    description: 'Own files only, unless the caller holds files:manage. Idempotent.',
  })
  @ApiNoContentResponse({ description: 'Deleted (or already absent)' })
  @ApiBadRequestResponse({ description: `Missing or malformed key (${PROBLEM})` })
  @ApiForbiddenResponse({ description: `FILE_ACCESS_DENIED: not your file (${PROBLEM})` })
  async deleteFile(
    @CurrentUser() user: AuthUser,
    @Query({ schema: FileKeyQuerySchema }) query: FileKeyQuery,
  ): Promise<void> {
    await this.files.deleteFile(user, query.key);
  }
}
