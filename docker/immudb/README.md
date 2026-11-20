# immudb state signing (local compose)

immudb signs the state it returns with an ECDSA P-256 key (`--signingKey`); the apps pin the public key and
reconciliation R5 verifies every state signature (outbox plan Task 18, D3).

**No private key lives in this repository.** The `immudb-keygen` one-shot job of `docker-compose.yml` generates a
development pair on its first run into the `immudb-signing` volume and keeps it:

| File in the volume (`/etc/immudb-signing`) | Used by                                                                           |
| ------------------------------------------ | --------------------------------------------------------------------------------- |
| `signing.key`                              | immudb (`--signingKey`, mounted read-only); never leaves the volume               |
| `signing.pub.pem`                          | monolith and billing-service (`IMMUDB_SERVER_SIGNING_PUBLIC_KEY_FILE`, read-only) |

The public file starts with the comment line `# compose-local development signing key, generated at start: not for
production`. PEM parsers skip it; the `immudb` config namespace recognises it and refuses the file in production
unless `ALLOW_KNOWN_LOCAL_SECRETS=true` (which only the compose stack sets).

```bash
# show the generated public key
docker compose run --rm --no-deps --entrypoint cat immudb-keygen /etc/immudb-signing/signing.pub.pem
# new key: stop immudb and the apps, then drop the volume. Read docs/SECURITY.md first (trusted state).
docker volume rm <project>_immudb-signing
```

Int and e2e specs generate their own key pair at test time. Production: generate, store and rotate the key as
described in [docs/SECURITY.md](../../docs/SECURITY.md#immudb-state-signing-key).
