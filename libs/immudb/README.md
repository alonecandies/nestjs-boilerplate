# @platform/immudb

immudb over gRPC for this repo: the client generated from immudb's `schema.proto` (pinned to server
1.11.2), a session pool with SQL transactions, versioned SQL migrations with provisioning, and
client-side verification of immudb's Merkle proofs. It names no domain.

## Regenerating the client

`bun run --filter @platform/immudb proto:gen` strips the REST/Swagger annotations from
`vendor/immudb-v1.11.2-schema.proto` (`scripts/strip-proto.mjs`) and runs buf with this package's own
`buf.gen.yaml` (ts-proto `outputServices=grpc-js`). `src/generated/**` is committed and checked for drift
in CI. To move to a new immudb version, vendor the new file, update the sha256 in
`test/strip-proto.spec.ts` and `IMMUDB_SERVER_VERSION`, regenerate, and re-run the int specs (error
strings are pinned to the server version).

## Licences

See `THIRD_PARTY_NOTICES.md`.
