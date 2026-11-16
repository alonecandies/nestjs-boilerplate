# Third-party notices: @platform/immudb

## immudb API definition (vendored)

- File: `vendor/immudb-v1.11.2-schema.proto` (stripped copy: `proto/immudb/schema/schema.proto`,
  generated code: `src/generated/**`).
- Source: https://github.com/codenotary/immudb/blob/v1.11.2/pkg/api/schema/schema.proto,
  sha256 `66d3a290d05cab73a36997656f6b75f8280f54cc231c81e3cd01cfb87589d4aa`.
- Licence: Apache License 2.0 (header of the file). Copyright 2022 Codenotary Inc.

## Ported verification code

Ported to TypeScript from immudb tag `v1.9DOM.1` (Apache License 2.0, Copyright Codenotary Inc.).
Later immudb versions (1.9DOM.2 and newer, including the 1.11.2 server this package talks to) are
licensed BUSL-1.1; no code from them is copied here. Each ported function is listed below with its
source file.

| TypeScript                                                                                                                                                                                | Source (`v1.9DOM.1`)                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `verifyHtreeInclusion` (`src/verification/htree.ts`)                                                                                                                                      | `embedded/htree/htree.go` `VerifyInclusion`                                                             |
| `evalAhtreeInclusion`, `verifyAhtreeInclusion`, `evalAhtreeConsistency`, `verifyAhtreeConsistency`, `evalAhtreeLastInclusion`, `verifyAhtreeLastInclusion` (`src/verification/ahtree.ts`) | `embedded/ahtree/verification.go`                                                                       |
| `leafFor`, `advanceLinearHash`, `verifyLinearProof`, `verifyLinearAdvanceProof`, `verifyDualProof`, `entrySpecDigestFor` (`src/verification/*.ts`)                                        | `embedded/store/verification.go`                                                                        |
| `txHeaderAlh` + inner hash, tx metadata bytes (`src/verification/tx-header.ts`)                                                                                                           | `embedded/store/tx.go` `TxHeader.innerHash`/`Alh`, `embedded/store/tx_metadata.go` `TxMetadata.Bytes`   |
| `fromProtoTxHeader`, `fromProtoDualProof` (`src/verification/tx-header.ts`, `src/verification/dual-proof.ts`)                                                                             | `pkg/api/schema/database_protoconv.go` `TxHeaderFromProto`, `TxMetadataFromProto`, `DualProofFromProto` |

## Apache License 2.0

Full text: https://www.apache.org/licenses/LICENSE-2.0.txt
