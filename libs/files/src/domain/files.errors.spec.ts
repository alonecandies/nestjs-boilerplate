import { toProblemDetails } from '@app/common';
import { describe, expect, it } from 'vitest';
import {
  FileAccessDeniedException,
  FileNotFoundException,
  FilesErrorCode,
  FileTooLargeException,
  UnsupportedFileTypeException,
  UploadCapacityExceededException,
} from './files.errors.js';

const problemOf = (error: unknown) => toProblemDetails(error, { exposeInternal: false });

describe('files domain errors', () => {
  it('map to stable codes and HTTP statuses', () => {
    expect(problemOf(new FileAccessDeniedException())).toMatchObject({
      status: 403,
      code: FilesErrorCode.FILE_ACCESS_DENIED,
    });
    expect(problemOf(new FileNotFoundException('users/u/k'))).toMatchObject({
      status: 404,
      code: FilesErrorCode.FILE_NOT_FOUND,
    });
    expect(problemOf(new FileTooLargeException(1024, 'file'))).toMatchObject({
      status: 413,
      code: FilesErrorCode.FILE_TOO_LARGE,
      detail: 'The file exceeds the maximum upload size of 1024 bytes',
      errors: [{ path: 'file', message: 'must be at most 1024 bytes', code: 'too_big' }],
    });
    expect(problemOf(new UnsupportedFileTypeException('image/svg+xml'))).toMatchObject({
      status: 415,
      code: FilesErrorCode.UNSUPPORTED_FILE_TYPE,
    });
    expect(problemOf(new UploadCapacityExceededException(4, 5))).toMatchObject({
      status: 503,
      code: FilesErrorCode.UPLOAD_CAPACITY_EXCEEDED,
    });
  });

  it('carry client-safe details', () => {
    expect(new FileTooLargeException(10, 'contentLength').details).toEqual({
      maxBytes: 10,
      issues: [{ path: 'contentLength', message: 'must be at most 10 bytes', code: 'too_big' }],
    });
    expect(new UploadCapacityExceededException(4, 5).details).toEqual({
      maxConcurrentUploads: 4,
      retryAfterSec: 5,
    });
    expect(new FileAccessDeniedException().details).toBeUndefined();
    expect(new FileNotFoundException('users/u/k').details).toMatchObject({
      entity: 'File',
      id: 'users/u/k',
    });
  });

  it('truncates an echoed (client-supplied) content type', () => {
    const error = new UnsupportedFileTypeException(`image/${'x'.repeat(500)}`);
    expect(error.contentType.length).toBeLessThanOrEqual(100);
    expect(error.message.length).toBeLessThan(160);
  });
});
