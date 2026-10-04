import { applyDecorators } from '@nestjs/common';
import { ApiBody, ApiConsumes } from '@nestjs/swagger';
import { ALLOWED_UPLOAD_CONTENT_TYPES, UPLOAD_FILE_FIELD } from '../../files.constants.js';

/**
 * OpenAPI for a `multipart/form-data` body made of a single binary `file` part. Needed because a
 * streamed upload has no DTO Swagger could introspect.
 */
export function ApiMultipartFileBody(description: string): MethodDecorator {
  const allowedTypes = ALLOWED_UPLOAD_CONTENT_TYPES.join(', ');
  return applyDecorators(
    ApiConsumes('multipart/form-data'),
    ApiBody({
      description,
      required: true,
      schema: {
        type: 'object',
        required: [UPLOAD_FILE_FIELD],
        additionalProperties: false,
        properties: {
          [UPLOAD_FILE_FIELD]: {
            type: 'string',
            format: 'binary',
            description: `The file (${allowedTypes})`,
          },
        },
      },
      encoding: { [UPLOAD_FILE_FIELD]: { contentType: allowedTypes } },
    }),
  );
}
