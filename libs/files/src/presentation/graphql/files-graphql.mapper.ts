import { map } from 'lodash-es';
import type { FileUploadUrl } from '../../application/files.types.js';
import type { PresignedUploadModel } from './presigned-upload.model.js';

export function toPresignedUploadModel(upload: FileUploadUrl): PresignedUploadModel {
  return {
    key: upload.key,
    filename: upload.filename,
    url: upload.url,
    method: upload.method,
    headers: map(upload.headers, (value, name) => ({ name, value })),
    expiresAt: upload.expiresAt,
  };
}
