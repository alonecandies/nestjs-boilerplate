import { Field, InputType, Int } from '@nestjs/graphql';
import { IsInt, IsNotEmpty, IsPositive, IsString, Matches, MaxLength } from 'class-validator';
import {
  ALLOWED_UPLOAD_CONTENT_TYPE_PATTERN,
  ALLOWED_UPLOAD_CONTENT_TYPES,
  MAX_FILENAME_LENGTH,
} from '../../files.constants.js';

// Media types are case-insensitive; FilesService lower-cases before signing.
const CONTENT_TYPE_PATTERN = new RegExp(ALLOWED_UPLOAD_CONTENT_TYPE_PATTERN.source, 'i');

/**
 * `createUploadUrl(input:)`. Every field carries class-validator decorators: the global
 * ValidationPipe (whitelist + forbidNonWhitelisted) would reject undecorated ones.
 */
@InputType({ description: 'Request for a presigned PUT upload URL' })
export class CreateUploadUrlInput {
  @Field(() => String, { description: 'Original filename; sanitized into the object key' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_FILENAME_LENGTH)
  filename: string;

  @Field(() => String, {
    description: `Content-Type the client will send. One of: ${ALLOWED_UPLOAD_CONTENT_TYPES.join(', ')}`,
  })
  @IsString()
  @Matches(CONTENT_TYPE_PATTERN, { message: 'contentType is not an accepted file type' })
  contentType: string;

  @Field(() => Int, {
    description: 'Exact size in bytes (signed into the URL; at most STORAGE_MAX_UPLOAD_BYTES)',
  })
  @IsInt()
  @IsPositive()
  contentLength: number;
}
