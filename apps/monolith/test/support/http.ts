import { HTTP_HEADERS, PROBLEM_JSON_CONTENT_TYPE, type ProblemDetails } from '@app/common';
import { expect } from 'vitest';

/** The slice of Fastify's `inject()` response the assertions read. */
export interface InjectedResponse {
  statusCode: number;
  headers: Record<string, string | string[] | number | undefined>;
  body: string;
  json: <T = unknown>() => T;
}

export const bearer = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
});

/**
 * Asserts an RFC 9457 problem response and returns it. The body's `requestId` must be the id the
 * response header carries (one id for the header, the body and the log line).
 */
export function expectProblem(
  response: InjectedResponse,
  status: number,
  code?: string,
): ProblemDetails {
  expect(response.statusCode, response.body).toBe(status);
  expect(response.headers['content-type']).toBe(PROBLEM_JSON_CONTENT_TYPE);
  const problem = response.json<ProblemDetails>();
  expect(problem.status).toBe(status);
  if (code !== undefined) expect(problem.code).toBe(code);
  expect(problem.requestId).toBe(response.headers[HTTP_HEADERS.REQUEST_ID]);
  return problem;
}

/** A single-file `multipart/form-data` body (field `file`) for `inject()`. */
export function multipartFile(
  filename: string,
  contentType: string,
  content: string,
): { payload: string; headers: Record<string, string> } {
  const boundary = `----e2e${Date.now().toString(16)}`;
  const payload = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="file"; filename="${filename}"`,
    `Content-Type: ${contentType}`,
    '',
    content,
    `--${boundary}--`,
    '',
  ].join('\r\n');
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

/** `POST /graphql` body + headers. */
export function graphql(
  query: string,
  variables?: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return {
    method: 'POST' as const,
    url: '/graphql',
    headers: { 'content-type': 'application/json', ...headers },
    payload: JSON.stringify(variables === undefined ? { query } : { query, variables }),
  };
}
