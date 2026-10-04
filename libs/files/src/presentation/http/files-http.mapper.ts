import { compactObject } from '@app/common';
import type {
  FileDownloadUrl,
  FileUploadUrl,
  UploadedFile,
} from '../../application/files.types.js';
import type {
  DownloadUrlResponse,
  PresignedUploadResponse,
  UploadedFileResponse,
} from './files.response.js';

export function toUploadedFileResponse(file: UploadedFile): UploadedFileResponse {
  return {
    key: file.key,
    filename: file.filename,
    contentType: file.contentType,
    ...compactObject({ size: file.size, etag: file.etag }),
  };
}

export function toPresignedUploadResponse(upload: FileUploadUrl): PresignedUploadResponse {
  return {
    key: upload.key,
    filename: upload.filename,
    url: upload.url,
    method: upload.method,
    headers: upload.headers,
    expiresAt: upload.expiresAt.toISOString(),
  };
}

export function toDownloadUrlResponse(download: FileDownloadUrl): DownloadUrlResponse {
  return {
    key: download.key,
    filename: download.filename,
    url: download.url,
    expiresAt: download.expiresAt.toISOString(),
    size: download.size,
    ...compactObject({ contentType: download.contentType }),
  };
}
