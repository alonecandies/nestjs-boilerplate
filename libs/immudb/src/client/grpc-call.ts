import type {
  CallOptions,
  ClientReadableStream,
  ClientUnaryCall,
  Metadata,
  ServiceError,
} from '@grpc/grpc-js';

export type UnaryMethod<TReq, TRes> = (
  request: TReq,
  metadata: Metadata,
  options: Partial<CallOptions>,
  callback: (error: ServiceError | null, response: TRes) => void,
) => ClientUnaryCall;

export type ServerStreamMethod<TReq, TRes> = (
  request: TReq,
  metadata: Metadata,
  options: Partial<CallOptions>,
) => ClientReadableStream<TRes>;

/** One unary call with a deadline, as a promise. */
export function unary<TReq, TRes>(
  method: UnaryMethod<TReq, TRes>,
  request: TReq,
  metadata: Metadata,
  timeoutMs: number,
): Promise<TRes> {
  return new Promise<TRes>((resolve, reject) => {
    method(request, metadata, { deadline: Date.now() + timeoutMs }, (error, response) => {
      if (error === null) resolve(response);
      else reject(error);
    });
  });
}

/** Drains a server stream (immudb streams SQL results in chunks). */
export function drain<TReq, TRes>(
  method: ServerStreamMethod<TReq, TRes>,
  request: TReq,
  metadata: Metadata,
  timeoutMs: number,
): Promise<TRes[]> {
  return new Promise<TRes[]>((resolve, reject) => {
    const chunks: TRes[] = [];
    const stream = method(request, metadata, { deadline: Date.now() + timeoutMs });
    stream.on('data', (chunk: TRes) => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(chunks));
  });
}
