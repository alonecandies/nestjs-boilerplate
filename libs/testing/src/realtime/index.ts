/**
 * @platform/testing/realtime: helpers for specs that open REAL connections (socket.io-client,
 * graphql-ws) to an app listening on the loopback interface. Import it only from `*.e2e-spec.ts`.
 */
export * from './listen-on-loopback.js';
export * from './socket-client.js';
