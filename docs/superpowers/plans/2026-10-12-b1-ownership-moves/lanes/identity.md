# Lane identity: B1 ownership moves for the identity context

**Baseline.** Line numbers are hints, taken at `7040115` plus the D and F work in progress in the working tree on 2026-10-12 (`libs/config/src/namespaces/auth.config.ts`, `libs/config/src/namespaces/production-guards.spec.ts`, `.env.example`, `docs/SECURITY.md`, `docs/CONFIGURATION.md`, `apps/identity-service/src/app.module.ts`). D and F commit before B1 runs, so every edit is anchored on its **old text**. If an old snippet no longer matches because D or F reworded it, apply the same change to their wording.

**Conventions.**
- After every code step, run `bunx biome check --write <touched files>`. Biome owns the import and export order and the formatting, so the snippets give content, not final order.
- After every Markdown edit, run `bunx prettier --write <touched .md files>`. It realigns the tables.

**Decisions this lane fixes (reviewable):**
- **`TokenService` keeps its name and only verifies.** It keeps `verifyAccessToken`, `toAuthUser` and `verificationSettings`. Its other injectors only verify, so they need no change:
  - `libs/graphql/src/graphql.module.ts:5,59-66` and `libs/graphql/src/auth/subscription-auth.ts:2,40-48`;
  - `libs/auth/src/ws/socket-auth.ts:5,46,56`;
  - `domains/notifications/src/presentation/ws/notifications.gateway.ts:21,101`.
- **`libs/graphql/src/auth/subscription-auth.spec.ts` needs no change.** It never mints a token: it mocks `verifyAccessToken`/`toAuthUser` with `vi.fn` (`:57-68`) and imports only `type TokenService`.
- **Claim shapes stay in `@platform/auth`.** `AccessTokenSubject`, `IssuedAccessToken`, `IssuedRefreshToken`, `RefreshTokenClaims` and `parseRefreshTokenClaims` are shared by the issuer and the verifiers. The `typ` cross-check (`libs/auth/src/tokens/token-claims.ts:38-40`) stays in one parser. What moves is the capability: the refresh secret and TTL, signing, and refresh-token verification.
- **`TokenIssuer` reads two namespaces.** `JWT_ACCESS_SECRET`, `JWT_ACCESS_TTL_SEC`, `JWT_ISSUER` and `JWT_AUDIENCE` stay in the platform `auth` namespace, because every verifier reads them. The refresh secret and TTL come from identity's `refreshTokenConfig`. Every sign and verify call passes its secret, algorithm, `iss` and `aud`, exactly as `libs/auth/src/tokens/token.service.ts:110-117` does today, so the claims are byte-identical. Identity's `JwtModule.register({})` therefore needs no defaults.
- **The gateway e2e fake identity-service signs with identity's real `TokenIssuer`.** Its refresh tokens must be JWTs (`@IsJWT()`, `domains/identity/src/presentation/http/dto/refresh-token.dto.ts:7`) and are verified on refresh, so `signTestAccessToken` alone cannot serve that fake.

---

### Task identity-1: `@platform/auth/testing` access-token signer

**Files:**
- Create: `libs/auth/src/testing/sign-test-access-token.ts`
- Create: `libs/auth/src/testing/index.ts`
- Test: `libs/auth/src/testing/sign-test-access-token.spec.ts`
- Modify: `libs/auth/package.json:7-14` (exports gain `./testing`)
- Modify: `libs/auth/src/guards/jwt-auth.guard.spec.ts:1-18,44-45`
- Modify: `libs/auth/src/ws/socket-auth.spec.ts:8-10,53,73`
- Modify: `libs/auth/src/auth.module.spec.ts:14,34,45-51`
- Modify: `libs/bootstrap/src/integration.smoke.spec.ts:30-39,152-159,247`
- Modify: `libs/auth/README.md:30` (Public API table)

**Interfaces:**
- Consumes:
  - from `libs/auth/src/types/auth-user.ts`: `AccessTokenSubject`, `IssuedAccessToken`;
  - from `libs/auth/src/auth.constants.ts`: `JWT_ALGORITHM`;
  - from `@platform/config`: `authConfig`, `AuthConfig`;
  - from `@platform/common`: `generateId`;
  - from `@nestjs/jwt`: `JwtService`.
- Produces:
  - the subpath `@platform/auth/testing`, which exports `signTestAccessToken(claims: AccessTokenSubject, options?: SignTestAccessTokenOptions): Promise<IssuedAccessToken>`;
  - `interface SignTestAccessTokenOptions { readonly config?: Pick<AuthConfig, 'accessSecret' | 'accessTtlSec' | 'issuer' | 'audience'> }`. The default config is `authConfig.parse()`, the `auth` namespace of `process.env`, which is what `AuthModule` verifies with in a test app.

- [ ] **Step 1: Write the failing test.** Create `libs/auth/src/testing/sign-test-access-token.spec.ts`:

```ts
import { JwtService } from '@nestjs/jwt';
import { isUuidV7 } from '@platform/common';
import { type AuthConfig, authConfig } from '@platform/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createJwtModuleOptions } from '../auth.module.js';
import { Role } from '../rbac/role.enum.js';
import { TokenService } from '../tokens/token.service.js';
import { signTestAccessToken } from './sign-test-access-token.js';

const config = authConfig.parse({ NODE_ENV: 'test', JWT_ACCESS_TTL_SEC: '600' });
const verifierFor = (settings: AuthConfig): TokenService =>
  new TokenService(new JwtService(createJwtModuleOptions(settings)), settings);
const subject = {
  id: '0190f3b2-0000-7000-8000-000000000001',
  email: 'a@b.c',
  roles: [Role.Admin],
};

describe('signTestAccessToken', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('signs an access token the platform verifier accepts, claim for claim', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const now = Math.floor(Date.now() / 1_000);

    const issued = await signTestAccessToken(subject, { config });

    expect(issued).toMatchObject({ expiresIn: 600, exp: now + 600 });
    expect(isUuidV7(issued.jti)).toBe(true);
    await expect(verifierFor(config).verifyAccessToken(issued.token)).resolves.toEqual({
      sub: subject.id,
      email: 'a@b.c',
      roles: [Role.Admin],
      typ: 'access',
      jti: issued.jti,
      iat: now,
      exp: now + 600,
      iss: 'nestjs-boilerplate',
      aud: 'nestjs-boilerplate',
    });
  });

  it('defaults to the auth namespace of process.env, which AuthModule verifies with', async () => {
    const { token } = await signTestAccessToken(subject);
    await expect(verifierFor(authConfig.parse()).verifyAccessToken(token)).resolves.toMatchObject({
      sub: subject.id,
    });
  });

  it('is rejected by a verifier configured for another issuer', async () => {
    const { token } = await signTestAccessToken(subject, { config });
    const foreign = authConfig.parse({ NODE_ENV: 'test', JWT_ISSUER: 'someone-else' });
    await expect(verifierFor(foreign).verifyAccessToken(token)).rejects.toMatchObject({
      code: 'INVALID_TOKEN',
    });
  });
});
```

- [ ] **Step 2: Run it and see it fail.**

```bash
npx vitest run --project auth sign-test-access-token
```
Expected: FAIL with `Error: Failed to load url ./sign-test-access-token.js (resolved id: ./sign-test-access-token.js) in …/libs/auth/src/testing/sign-test-access-token.spec.ts. Does the file exist?`, and no test runs.

- [ ] **Step 3: Implement the signer and the subpath barrel.** Create `libs/auth/src/testing/sign-test-access-token.ts`:

```ts
import { JwtService } from '@nestjs/jwt';
import { generateId } from '@platform/common';
import { type AuthConfig, authConfig } from '@platform/config';
import { JWT_ALGORITHM } from '../auth.constants.js';
import type { AccessTokenSubject, IssuedAccessToken } from '../types/auth-user.js';

export interface SignTestAccessTokenOptions {
  /**
   * Signing settings. Default: the `auth` namespace of `process.env`, i.e. what `AuthModule`
   * verifies with in a test app (the development secret unless the environment overrides it).
   */
  readonly config?: Pick<AuthConfig, 'accessSecret' | 'accessTtlSec' | 'issuer' | 'audience'>;
}

const jwt = new JwtService();

/**
 * TEST-ONLY: signs an access token exactly like the production issuer (HS256, `iss`/`aud`,
 * `typ: 'access'`, uuidv7 `jti`, `iat`/`exp` from one clock read), so platform and domain specs
 * can authenticate requests without depending on the domain that issues tokens. Production code
 * never imports `@platform/auth/testing`.
 */
export async function signTestAccessToken(
  claims: AccessTokenSubject,
  options: SignTestAccessTokenOptions = {},
): Promise<IssuedAccessToken> {
  const config = options.config ?? authConfig.parse();
  const iat = Math.floor(Date.now() / 1_000);
  const exp = iat + config.accessTtlSec;
  const jti = generateId();
  const payload = {
    sub: claims.id,
    email: claims.email,
    roles: [...claims.roles],
    typ: 'access',
    jti,
    iat,
    exp,
  };
  const token = await jwt.signAsync(payload, {
    secret: config.accessSecret,
    algorithm: JWT_ALGORITHM,
    issuer: config.issuer,
    audience: config.audience,
  });
  return { token, jti, expiresIn: config.accessTtlSec, exp };
}
```

Create `libs/auth/src/testing/index.ts`:

```ts
/**
 * @platform/auth/testing — test helpers for code that depends on @platform/auth. Not imported by
 * production code (separate subpath so it never lands in a service's module graph).
 */
export { type SignTestAccessTokenOptions, signTestAccessToken } from './sign-test-access-token.js';
```

- [ ] **Step 4: Export the subpath** in `libs/auth/package.json`. This follows the pattern in `libs/redis/package.json:13-17`. Replace:

```json
    ".": {
      "@repo/source": "./src/index.ts",
      "types": "./src/index.ts",
      "default": "./dist/index.js"
    },
    "./package.json": "./package.json"
```
with:
```json
    ".": {
      "@repo/source": "./src/index.ts",
      "types": "./src/index.ts",
      "default": "./dist/index.js"
    },
    "./testing": {
      "@repo/source": "./src/testing/index.ts",
      "types": "./src/testing/index.ts",
      "default": "./dist/testing/index.js"
    },
    "./package.json": "./package.json"
```

- [ ] **Step 5: Run the spec.**

```bash
npx vitest run --project auth sign-test-access-token
```
Expected: PASS (3 tests).

- [ ] **Step 6: Switch the auth specs that minted tokens through `TokenService`.**

In `libs/auth/src/guards/jwt-auth.guard.spec.ts`, replace:
```ts
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Public, UnauthenticatedException } from '@platform/common';
```
with:
```ts
import { Reflector } from '@nestjs/core';
import { Public, UnauthenticatedException } from '@platform/common';
```
Replace:
```ts
import { createJwtModuleOptions } from '../auth.module.js';
import { Role } from '../rbac/role.enum.js';
import { JwtStrategy } from '../strategies/jwt.strategy.js';
import { makeAuthUser } from '../testing/auth-test.utils.js';
import { AccessTokenDenylist } from '../tokens/access-token-denylist.service.js';
import { TokenService } from '../tokens/token.service.js';
```
with:
```ts
import { Role } from '../rbac/role.enum.js';
import { JwtStrategy } from '../strategies/jwt.strategy.js';
import { makeAuthUser } from '../testing/auth-test.utils.js';
import { signTestAccessToken } from '../testing/sign-test-access-token.js';
import { AccessTokenDenylist } from '../tokens/access-token-denylist.service.js';
```
Delete the line:
```ts
const tokens = new TokenService(new JwtService(createJwtModuleOptions(config)), config);
```
Replace:
```ts
const bearer = async (roles = [Role.User]): Promise<{ token: string; jti: string; exp: number }> =>
  tokens.issueAccessToken({ id: 'u-1', email: 'a@b.c', roles });
```
with:
```ts
const bearer = async (roles = [Role.User]): Promise<{ token: string; jti: string; exp: number }> =>
  signTestAccessToken({ id: 'u-1', email: 'a@b.c', roles }, { config });
```

In `libs/auth/src/ws/socket-auth.spec.ts`, replace:
```ts
import { Role } from '../rbac/role.enum.js';
```
with:
```ts
import { Role } from '../rbac/role.enum.js';
import { signTestAccessToken } from '../testing/sign-test-access-token.js';
```
Replace `const { token, jti } = await tokens.issueAccessToken(user);` with `const { token, jti } = await signTestAccessToken(user, { config });`. Replace `const { token, jti, exp } = await tokens.issueAccessToken(user);` with `const { token, jti, exp } = await signTestAccessToken(user, { config });`. The `tokens` instance stays, because `authenticateSocket` verifies with it.

In `libs/auth/src/auth.module.spec.ts`, replace:
```ts
import { Role } from './rbac/role.enum.js';
```
with:
```ts
import { Role } from './rbac/role.enum.js';
import { signTestAccessToken } from './testing/sign-test-access-token.js';
```
Replace `it('provides token issuing/verification, hashing and the denylist from config', async () => {` with `it('provides token verification, hashing and the denylist from config', async () => {`. Replace:
```ts
    const tokens = app.get(TokenService);
    const issued = await tokens.issueAccessToken({
      id: 'u-1',
      email: 'a@b.c',
      roles: [Role.Admin],
    });
    await expect(tokens.verifyAccessToken(issued.token)).resolves.toMatchObject({ sub: 'u-1' });
```
with:
```ts
    const tokens = app.get(TokenService);
    // Signed with the `auth` namespace of process.env: the config this module loaded.
    const issued = await signTestAccessToken({ id: 'u-1', email: 'a@b.c', roles: [Role.Admin] });
    await expect(tokens.verifyAccessToken(issued.token)).resolves.toMatchObject({ sub: 'u-1' });
```

- [ ] **Step 7: Switch the bootstrap smoke spec to the subpath.** This proves that the exports map resolves from another package. In `libs/bootstrap/src/integration.smoke.spec.ts`, replace:
```ts
  Role,
  TokenService,
} from '@platform/auth';
```
with:
```ts
  Role,
  TokenService,
} from '@platform/auth';
import { signTestAccessToken } from '@platform/auth/testing';
```
Replace:
```ts
  const bearer = async (roles: Role[] = [Role.User]) => {
    const issued = await tokens.issueAccessToken({
```
with:
```ts
  const bearer = async (roles: Role[] = [Role.User]) => {
    // Signed with the `auth` namespace of process.env, which the app's AuthModule verifies with.
    const issued = await signTestAccessToken({
```
Replace `it('accepts a TokenService-issued access token: 200 with req.user', async () => {` with `it('accepts a signed access token (verified locally): 200 with req.user', async () => {`. `tokens = app.get(TokenService)` stays, because it still verifies at `:249`.

- [ ] **Step 8: Document the helper.** In `libs/auth/README.md`, insert this row directly below the row that starts with `` | `makeAuthUser(overrides?)` ``:
```markdown
| `signTestAccessToken(claims, { config? })` (subpath `@platform/auth/testing`) | test util | Signs an access token exactly like the production issuer (HS256, `iss`/`aud`, `typ`, uuidv7 `jti`) with `config`, by default the `auth` namespace of `process.env`. Platform and domain specs authenticate with it instead of minting through a service. (`makeAuthUser` stays on the root export.) |
```
Then run:
```bash
bunx prettier --write libs/auth/README.md
```

- [ ] **Step 9: Run the affected projects and the repo checks.**

```bash
bunx biome check --write libs/auth/src libs/auth/package.json libs/bootstrap/src/integration.smoke.spec.ts
npx vitest run --project auth --project bootstrap
bun run check
```
Expected: biome applies its fixes. Vitest: PASS (both projects). `bun run check`: PASS (biome ci, eslint, prettier, tsc and check-boundaries, where libs → libs is allowed).

- [ ] **Step 10: Commit.**

```bash
git add libs/auth/package.json libs/auth/src/testing/index.ts libs/auth/src/testing/sign-test-access-token.ts libs/auth/src/testing/sign-test-access-token.spec.ts libs/auth/src/guards/jwt-auth.guard.spec.ts libs/auth/src/ws/socket-auth.spec.ts libs/auth/src/auth.module.spec.ts libs/bootstrap/src/integration.smoke.spec.ts libs/auth/README.md
git commit -F - <<'EOF'
test(auth): add the @platform/auth/testing access-token signer

signTestAccessToken(claims, { config? }) signs an access token exactly like
the production issuer. The auth guard, socket and module specs and the
bootstrap smoke spec mint their tokens with it instead of TokenService, which
keeps only verification once issuance moves into identity.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task identity-2: Domain test harnesses sign tokens with `@platform/auth/testing`

**Files:**
- Modify: `domains/identity/test/auth-test.module.ts:3,5,18-22,36-46`
- Modify: `domains/billing/test/billing-http-test.utils.ts:1-5,9,11,34`
- Modify: `domains/files/src/testing/files-test-app.test.ts:5,7,12-16,72-79`
- Modify: `domains/notifications/test/support/edge-test-app.ts:4,6,31-35,56-67`
- Modify: `domains/notifications/src/presentation/ws/notifications.gateway.spec.ts:2,78-80`
- Modify: `domains/billing/README.md:228`, `domains/files/README.md:160`
- Test: the Vitest projects `identity`, `billing`, `files` and `notifications`, plus `tsc` through `bun run check`

**Interfaces:**
- Consumes: `signTestAccessToken` from `@platform/auth/testing` (Task identity-1), and `authConfig`/`AuthConfig` from `@platform/config`.
- Produces: unchanged helper signatures, which other lanes' specs keep calling:
  - `principal(app, roles, id?)` (identity);
  - `loginAs(app, ...roles)` (billing);
  - `tokenFor(roles, userId?)` (files);
  - `bearer(app, user)` (notifications).

  Each signs with the app's own `auth` config (`app.get<AuthConfig>(authConfig.KEY)`). That keeps the `app` parameter meaningful and follows any test override of the namespace.

- [ ] **Step 1: Identity's `principal()`.** In `domains/identity/test/auth-test.module.ts`, replace:
```ts
import { AuthModule, type Role, TokenService } from '@platform/auth';
```
with:
```ts
import { AuthModule, type Role } from '@platform/auth';
import { signTestAccessToken } from '@platform/auth/testing';
```
Replace `import { AppConfigModule, redisConfig } from '@platform/config';` with `import { AppConfigModule, type AuthConfig, authConfig, redisConfig } from '@platform/config';`. Replace ` * The real auth stack of an edge app: config, JWT issuing/verification (dev secrets), the` with ` * The real auth stack of an edge app: config, JWT verification (dev secrets), the`. Replace:
```ts
/** Issues a real access token for a user with `roles`. */
export async function principal(
  app: INestApplication,
  roles: Role[],
  id: string = generateId(),
): Promise<TestPrincipal> {
  const issued = await app
    .get(TokenService)
    .issueAccessToken({ id, email: 'p@example.com', roles });
  return { id, token: issued.token, jti: issued.jti, exp: issued.exp };
}
```
with:
```ts
/** A real access token for a user with `roles`, signed with the app's `auth` config. */
export async function principal(
  app: INestApplication,
  roles: Role[],
  id: string = generateId(),
): Promise<TestPrincipal> {
  const issued = await signTestAccessToken(
    { id, email: 'p@example.com', roles },
    { config: app.get<AuthConfig>(authConfig.KEY) },
  );
  return { id, token: issued.token, jti: issued.jti, exp: issued.exp };
}
```

- [ ] **Step 2: Billing's `loginAs()`.** In `domains/billing/test/billing-http-test.utils.ts`, replace:
```ts
 * Edge test harness: real AuthModule (JWT guards → RBAC guards, tokens issued by the real
 * TokenService with the dev/test secret), Redis replaced by the in-memory fake, and the common
 * enhancers (both validation pipes + problem+json filter) exactly as the apps install them.
```
with:
```ts
 * Edge test harness: real AuthModule (JWT guards → RBAC guards; tokens signed by
 * signTestAccessToken with the app's auth config), Redis replaced by the in-memory fake, and the
 * common enhancers (both validation pipes + problem+json filter) exactly as the apps install them.
```
Replace `import { Role, TokenService } from '@platform/auth';` with:
```ts
import { Role } from '@platform/auth';
import { signTestAccessToken } from '@platform/auth/testing';
```
Replace `import { redisConfig } from '@platform/config';` with `import { type AuthConfig, authConfig, redisConfig } from '@platform/config';`. Replace:
```ts
  const { token } = await app.get(TokenService).issueAccessToken({ id, email, roles });
```
with:
```ts
  const { token } = await signTestAccessToken(
    { id, email, roles },
    { config: app.get<AuthConfig>(authConfig.KEY) },
  );
```

- [ ] **Step 3: Files' `tokenFor()`.** In `domains/files/src/testing/files-test-app.test.ts`, replace:
```ts
import { AccessTokenDenylist, AuthModule, type Role, TokenService } from '@platform/auth';
```
with:
```ts
import { AccessTokenDenylist, AuthModule, type Role } from '@platform/auth';
import { signTestAccessToken } from '@platform/auth/testing';
```
Replace `import { storageConfig } from '@platform/config';` with `import { type AuthConfig, authConfig, storageConfig } from '@platform/config';`. Replace:
```ts
 * Boots `FilesModule` the way the gateway/monolith do — real AuthModule guards and
 * TokenService, the common enhancers (validation pipes + problem+json filter), a Fastify adapter
```
with:
```ts
 * Boots `FilesModule` the way the gateway/monolith do — real AuthModule guards (tokens from
 * signTestAccessToken), the common enhancers (validation pipes + problem+json filter), a Fastify adapter
```
Then replace:
```ts
  const tokens = app.get(TokenService);

  return {
    app,
    storage,
    tokenFor: async (roles, userId = generateId()) =>
      (await tokens.issueAccessToken({ id: userId, email: `${userId}@example.com`, roles })).token,
  };
```
with:
```ts
  const config = app.get<AuthConfig>(authConfig.KEY);

  return {
    app,
    storage,
    tokenFor: async (roles, userId = generateId()) =>
      (await signTestAccessToken({ id: userId, email: `${userId}@example.com`, roles }, { config }))
        .token,
  };
```

- [ ] **Step 4: Notifications' `bearer()` and the gateway spec.** In `domains/notifications/test/support/edge-test-app.ts`, replace:
```ts
import { AuthModule, type Role, TokenService } from '@platform/auth';
```
with:
```ts
import { AuthModule, type Role } from '@platform/auth';
import { signTestAccessToken } from '@platform/auth/testing';
```
Replace `import { AppConfigModule, redisConfig } from '@platform/config';` with `import { AppConfigModule, type AuthConfig, authConfig, redisConfig } from '@platform/config';`. Replace ` * permissions guards, real TokenService), the common enhancers (both validation pipes,` with ` * permissions guards, real token verification), the common enhancers (both validation pipes,`. Then replace:
```ts
/** A real access token (signed with the configured secret) for `user`. */
export async function bearer(
  app: EdgeTestApp,
  user: { id: string; roles: Role[]; email?: string },
): Promise<string> {
  const issued = await app.get(TokenService).issueAccessToken({
    id: user.id,
    email: user.email ?? 'ada@example.com',
    roles: user.roles,
  });
  return `Bearer ${issued.token}`;
}
```
with:
```ts
/** A real access token (signed with the app's `auth` config) for `user`. */
export async function bearer(
  app: EdgeTestApp,
  user: { id: string; roles: Role[]; email?: string },
): Promise<string> {
  const issued = await signTestAccessToken(
    { id: user.id, email: user.email ?? 'ada@example.com', roles: user.roles },
    { config: app.get<AuthConfig>(authConfig.KEY) },
  );
  return `Bearer ${issued.token}`;
}
```
In `domains/notifications/src/presentation/ws/notifications.gateway.spec.ts`, replace:
```ts
import { AccessTokenDenylist, AuthModule, Role, TokenService } from '@platform/auth';
```
with:
```ts
import { AccessTokenDenylist, AuthModule, Role, TokenService } from '@platform/auth';
import { signTestAccessToken } from '@platform/auth/testing';
```
Replace:
```ts
    const accessToken = () =>
      tokens.issueAccessToken({ id: USER_ID, email: 'a@b.io', roles: [Role.User] });
```
with:
```ts
    // Signed with the auth namespace of process.env, which AppConfigModule + AuthModule load.
    const accessToken = () =>
      signTestAccessToken({ id: USER_ID, email: 'a@b.io', roles: [Role.User] });
```
`tokens` stays, because the gateway under test verifies with it.

- [ ] **Step 5: Update the docs.** In `domains/billing/README.md`, replace:
```markdown
(tokens from `TokenService`)
```
with:
```markdown
(tokens from `signTestAccessToken`, `@platform/auth/testing`)
```
In `domains/files/README.md`, replace:
```markdown
and real JWTs from `TokenService`.
```
with:
```markdown
and real JWTs from `signTestAccessToken` (`@platform/auth/testing`).
```
Then run:
```bash
bunx prettier --write domains/billing/README.md domains/files/README.md
```

- [ ] **Step 6: Run the affected projects and the repo checks.**

```bash
bunx biome check --write domains/identity/test/auth-test.module.ts domains/billing/test/billing-http-test.utils.ts domains/files/src/testing/files-test-app.test.ts domains/notifications/test/support/edge-test-app.ts domains/notifications/src/presentation/ws/notifications.gateway.spec.ts
npx vitest run --project identity --project billing --project files --project notifications
bun run check
git grep -n "issueAccessToken" -- domains libs apps
```
Expected:
- Vitest: PASS for all four projects.
- `bun run check`: PASS. Domains may import `@platform/auth/testing`.
- The grep lists only these files:
  - `libs/auth/src/tokens/token.service.ts` and `libs/auth/src/tokens/token.service.spec.ts`;
  - `libs/auth/src/types/auth-user.ts` (a comment) and `libs/auth/README.md` (the `TokenService` row);
  - `domains/identity/src/application/services/session-tokens.service.ts` and its spec;
  - `apps/gateway/test/support/fake-upstreams.ts`.

  Task identity-6 and Task identity-7 handle them.

- [ ] **Step 7: Commit.**

```bash
git add domains/identity/test/auth-test.module.ts domains/billing/test/billing-http-test.utils.ts domains/files/src/testing/files-test-app.test.ts domains/notifications/test/support/edge-test-app.ts domains/notifications/src/presentation/ws/notifications.gateway.spec.ts domains/billing/README.md domains/files/README.md
git commit -F - <<'EOF'
test(repo): sign domain test tokens with @platform/auth/testing

The identity, billing, files and notifications harnesses sign their access
tokens with signTestAccessToken and the app's own auth config instead of
calling TokenService.issueAccessToken. Helper signatures do not change.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task identity-3: `normalizeEmail` moves from `@platform/common` to identity's domain

**Files:**
- Create: `domains/identity/src/domain/email.ts`
- Test: `domains/identity/src/domain/email.spec.ts`
- Modify: `domains/identity/src/application/commands/login/login.handler.ts:4`
- Modify: `domains/identity/src/application/commands/register-user/register-user.handler.ts:3`
- Modify: `domains/identity/src/domain/user.aggregate.ts:2`
- Modify: `domains/identity/src/presentation/shared/transforms.ts:1`
- Modify: `domains/identity/src/index.ts:35` ("// Domain." block)
- Modify: `apps/gateway/test/support/fake-upstreams.ts:1-10`
- Modify: `libs/common/src/utils/string.util.ts:3-6`, `libs/common/src/utils/string.util.spec.ts:2,5-7`
- Modify: `libs/common/README.md:31` (F also edits this file, at `:52-53`; the edit here is targeted), `domains/identity/README.md:12`

**Interfaces:**
- Consumes: nothing new.
- Produces: `normalizeEmail(email: string): string`, exported from `@domain/identity` and defined in `domains/identity/src/domain/email.ts`. `@platform/common` no longer exports `normalizeEmail`. `maskEmail` and `toSafeFilename` stay, because platform mailer and platform storage use them.

- [ ] **Step 1: Write the failing test.** Create `domains/identity/src/domain/email.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { normalizeEmail } from './email.js';

describe('normalizeEmail', () => {
  it('trims and lower-cases: the canonical form users.email stores', () => {
    expect(normalizeEmail('  Ada.Lovelace@Example.COM ')).toBe('ada.lovelace@example.com');
  });

  it('is idempotent', () => {
    expect(normalizeEmail(normalizeEmail(' A@B.C '))).toBe('a@b.c');
  });
});
```

- [ ] **Step 2: Run it and see it fail.**

```bash
npx vitest run --project identity src/domain/email.spec.ts
```
Expected: FAIL with `Error: Failed to load url ./email.js (resolved id: ./email.js) … Does the file exist?`

- [ ] **Step 3: Implement.** Create `domains/identity/src/domain/email.ts`:

```ts
/** Canonical form used for uniqueness checks and lookups (`users.email` stores this form). */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
```

- [ ] **Step 4: Run it.**

```bash
npx vitest run --project identity src/domain/email.spec.ts
```
Expected: PASS (2 tests).

- [ ] **Step 5: Switch every importer.**
- `domains/identity/src/application/commands/login/login.handler.ts`: delete `import { normalizeEmail } from '@platform/common';` and add `import { normalizeEmail } from '../../../domain/email.js';`.
- `domains/identity/src/application/commands/register-user/register-user.handler.ts`: replace `import { generateId, normalizeEmail } from '@platform/common';` with `import { generateId } from '@platform/common';`, and add `import { normalizeEmail } from '../../../domain/email.js';`.
- `domains/identity/src/domain/user.aggregate.ts`: replace `import { generateId, normalizeEmail, type ValidationIssue } from '@platform/common';` with `import { generateId, type ValidationIssue } from '@platform/common';`, and add `import { normalizeEmail } from './email.js';`.
- `domains/identity/src/presentation/shared/transforms.ts`: replace `import { normalizeEmail } from '@platform/common';` with `import { normalizeEmail } from '../../domain/email.js';`.
- `domains/identity/src/index.ts`: replace:
```ts
// Domain.
export { UserRegisteredEvent } from './domain/events/user-registered.event.js';
```
with:
```ts
// Domain.
export { normalizeEmail } from './domain/email.js';
export { UserRegisteredEvent } from './domain/events/user-registered.event.js';
```
- `apps/gateway/test/support/fake-upstreams.ts`: replace:
```ts
  InvalidRefreshTokenException,
  UsersPort,
} from '@domain/identity';
```
with:
```ts
  InvalidRefreshTokenException,
  normalizeEmail,
  UsersPort,
} from '@domain/identity';
```
  Then replace `import { EntityNotFoundException, generateId, normalizeEmail } from '@platform/common';` with `import { EntityNotFoundException, generateId } from '@platform/common';`. **Execution-time rule:** if lane platform has already moved `FakeAuthPort`/`FakeUsersPort` into `domains/identity/src/testing/`, make the same change there, with the relative import `../domain/email.js`.

- [ ] **Step 6: Remove it from `@platform/common`.** In `libs/common/src/utils/string.util.ts`, delete:
```ts
/** Canonical form used for uniqueness checks and lookups (`users.email` stores this form). */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

```
In `libs/common/src/utils/string.util.spec.ts`, replace `import { maskEmail, normalizeEmail, toSafeFilename } from './string.util.js';` with `import { maskEmail, toSafeFilename } from './string.util.js';` and delete:
```ts
  it('normalizeEmail trims and lower-cases', () => {
    expect(normalizeEmail('  Ada.Lovelace@Example.COM ')).toBe('ada.lovelace@example.com');
  });

```

- [ ] **Step 7: Update the docs.**
- In `libs/common/README.md`, in the `Strings` row, replace `` `normalizeEmail`, `maskEmail`, `` with `` `maskEmail`, ``.
- In `domains/identity/README.md`, replace `│                           identity errors, USER_ROLES (pure TS: @nestjs/cqrs, @platform/common, lodash)` with `│                           identity errors, USER_ROLES, normalizeEmail (pure TS: @nestjs/cqrs, @platform/common, lodash)`.

Then run:
```bash
bunx prettier --write libs/common/README.md domains/identity/README.md
```

- [ ] **Step 8: Run the affected projects and the repo checks.**

```bash
bunx biome check --write domains/identity/src apps/gateway/test/support/fake-upstreams.ts libs/common/src/utils
npx vitest run --project identity --project common --project gateway:e2e
bun run check
git grep -n "normalizeEmail" -- libs
```
Expected: Vitest PASS; `bun run check` PASS; the grep prints nothing.

- [ ] **Step 9: Commit.**

```bash
git add domains/identity/src/domain/email.ts domains/identity/src/domain/email.spec.ts domains/identity/src/application/commands/login/login.handler.ts domains/identity/src/application/commands/register-user/register-user.handler.ts domains/identity/src/domain/user.aggregate.ts domains/identity/src/presentation/shared/transforms.ts domains/identity/src/index.ts apps/gateway/test/support/fake-upstreams.ts libs/common/src/utils/string.util.ts libs/common/src/utils/string.util.spec.ts libs/common/README.md domains/identity/README.md
git commit -F - <<'EOF'
refactor(identity): move normalizeEmail from @platform/common into identity

The canonical email form is an identity rule (users.email stores it), so it
lives in domains/identity/src/domain/email.ts and is exported from
@domain/identity. The gateway e2e fake imports it from there.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task identity-4: `PasswordHasher` and the `password` namespace move into identity

**Files:**
- Create: `domains/identity/src/infrastructure/security/password.config.ts`
- Test: `domains/identity/src/infrastructure/security/password.config.spec.ts`
- Move: `libs/auth/src/password/password-hasher.service.ts` -> `domains/identity/src/infrastructure/security/password-hasher.service.ts`
- Move: `libs/auth/src/password/password-hasher.service.spec.ts` -> `domains/identity/src/infrastructure/security/password-hasher.service.spec.ts`
- Modify: `domains/identity/src/identity.constants.ts:9-10` (adds `MAX_PASSWORD_LENGTH`)
- Modify: `domains/identity/src/identity-core.module.ts:1,20,42-58`
- Modify: `domains/identity/src/application/commands/login/login.handler.ts:3`, `domains/identity/src/application/commands/login/login.handler.spec.ts:1`
- Modify: `domains/identity/src/application/commands/register-user/register-user.handler.ts:2`, `domains/identity/src/application/commands/register-user/register-user.handler.spec.ts:1`
- Modify: `domains/identity/src/identity-api.module.spec.ts:4`
- Test: `domains/identity/src/identity-grpc.module.spec.ts` (new DI case)
- Modify: `domains/identity/src/index.ts:51-57,67-76`
- Modify: `domains/identity/package.json` (+ `@node-rs/argon2`); `libs/auth/package.json` (− `@node-rs/argon2`, description); `bun.lock`
- Modify: `libs/auth/src/auth.module.ts:11,19-20,50-51,73,83`, `libs/auth/src/auth.module.spec.ts:13,34,57-58`, `libs/auth/src/auth.constants.ts:28-29`, `libs/auth/src/index.ts:3,13,30`
- Modify: `libs/config/src/namespaces/auth.config.ts:22-25,70-75,79` (D's file; targeted edits)
- Modify: `libs/config/src/namespaces/namespaces.spec.ts:149,425` (D's file; targeted edits)
- Modify: `apps/identity-service/src/app.module.ts:41-42` (comment; F also edits this file)
- Modify (docs): `libs/auth/README.md`, `domains/identity/README.md`, `docs/SECURITY.md:23-24,87,90-91`, `docs/CONFIGURATION.md` (namespace table, `auth` section, new `password` section), `docs/PERFORMANCE.md:34`, `docs/ARCHITECTURE.md:51,78`, `README.md:313`, `apps/identity-service/README.md:27`, `libs/config/README.md:39`, `.env.example` (Argon2 comment)

**Interfaces:**
- Consumes:
  - from `@platform/config`: `defineConfigNamespace`, `zInt`, `EnvValidationError`;
  - from `@platform/common`: `DomainValidationException`.
- Produces, all exported from `@domain/identity`:
  - `passwordConfig = defineConfigNamespace('password', passwordEnvSchema)`. Its KEY is `'CONFIGURATION(password)'` and it reads `ARGON2_MEMORY_COST`, `ARGON2_TIME_COST` and `ARGON2_PARALLELISM`;
  - `type PasswordConfig = { argon2: { memoryCost: number; timeCost: number; parallelism: number } }`;
  - `PasswordHasher`, with `constructor(@Inject(passwordConfig.KEY) config: PasswordConfig)` and the unchanged methods `hash`, `verify`, `verifyDummy` and `needsRehash`;
  - `MAX_PASSWORD_LENGTH = 1_024`.

  `IdentityCoreModule` provides `PasswordHasher` and imports `ConfigModule.forFeature(passwordConfig)`. `@platform/auth` no longer exports `PasswordHasher` or `MAX_PASSWORD_LENGTH`, and `AuthModule` no longer provides it. `AuthConfig` loses `argon2`.

- [ ] **Step 1: Write the failing namespace test.** Run `mkdir -p domains/identity/src/infrastructure/security`, then create `domains/identity/src/infrastructure/security/password.config.spec.ts`:

```ts
import { EnvValidationError } from '@platform/config';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { type PasswordConfig, passwordConfig } from './password.config.js';

const errorOf = (fn: () => unknown): EnvValidationError => {
  try {
    fn();
  } catch (error) {
    if (error instanceof EnvValidationError) return error;
    throw error;
  }
  throw new Error('expected an EnvValidationError');
};

describe('password config namespace', () => {
  it('defaults to the OWASP Argon2id baseline with an empty environment', () => {
    expect(passwordConfig.parse({})).toEqual({
      argon2: { memoryCost: 19_456, timeCost: 2, parallelism: 1 },
    } satisfies PasswordConfig);
    expect(passwordConfig.KEY).toBe('CONFIGURATION(password)');
  });

  it('coerces the ARGON2_* variables', () => {
    expect(
      passwordConfig.parse({
        ARGON2_MEMORY_COST: '1024',
        ARGON2_TIME_COST: '1',
        ARGON2_PARALLELISM: '4',
      }).argon2,
    ).toEqual({ memoryCost: 1024, timeCost: 1, parallelism: 4 });
  });

  it.each([
    ['ARGON2_MEMORY_COST', '4'],
    ['ARGON2_TIME_COST', '0'],
    ['ARGON2_PARALLELISM', '256'],
  ])('rejects %s=%s by name', (variable, value) => {
    const error = errorOf(() => passwordConfig.parse({ [variable]: value }));
    expect(error.namespace).toBe('password');
    expect(error.message).toContain(`→ at ${variable}`);
  });

  it('keeps precise inferred types', () => {
    expectTypeOf<PasswordConfig['argon2']['memoryCost']>().toEqualTypeOf<number>();
  });
});
```

- [ ] **Step 2: Run it and see it fail.**

```bash
npx vitest run --project identity password.config
```
Expected: FAIL with `Failed to load url ./password.config.js … Does the file exist?`

- [ ] **Step 3: Create the namespace** at `domains/identity/src/infrastructure/security/password.config.ts`. It keeps a literal `z.object({` so that `scripts/check-env-example.mjs` finds the keys.

```ts
import type { ConfigType } from '@nestjs/config';
import { defineConfigNamespace, zInt } from '@platform/config';
import { z } from 'zod';

export const passwordEnvSchema = z
  .object({
    // OWASP 2024 Argon2id baseline: m=19 MiB, t=2, p=1.
    ARGON2_MEMORY_COST: zInt(19_456, { min: 8 }),
    ARGON2_TIME_COST: zInt(2, { min: 1 }),
    ARGON2_PARALLELISM: zInt(1, { min: 1, max: 255 }),
  })
  .transform((env) => ({
    argon2: {
      /** KiB. Hashing runs on the libuv threadpool — size UV_THREADPOOL_SIZE for login bursts. */
      memoryCost: env.ARGON2_MEMORY_COST,
      timeCost: env.ARGON2_TIME_COST,
      parallelism: env.ARGON2_PARALLELISM,
    },
  }));

/** Argon2id cost of identity's `PasswordHasher` (loaded by `IdentityCoreModule` only). */
export const passwordConfig = defineConfigNamespace('password', passwordEnvSchema);
export type PasswordConfig = ConfigType<typeof passwordConfig>;
```

- [ ] **Step 4: Run it.**

```bash
npx vitest run --project identity password.config
```
Expected: PASS (6 tests).

- [ ] **Step 5: Move the hasher and its spec.**

```bash
git mv libs/auth/src/password/password-hasher.service.ts domains/identity/src/infrastructure/security/password-hasher.service.ts
git mv libs/auth/src/password/password-hasher.service.spec.ts domains/identity/src/infrastructure/security/password-hasher.service.spec.ts
rmdir libs/auth/src/password 2>/dev/null || true
```
In the moved `password-hasher.service.ts`, replace:
```ts
import { type AuthConfig, authConfig } from '@platform/config';
import { MAX_PASSWORD_LENGTH } from '../auth.constants.js';
```
with:
```ts
import { MAX_PASSWORD_LENGTH } from '../../identity.constants.js';
import { type PasswordConfig, passwordConfig } from './password.config.js';
```
and replace `  constructor(@Inject(authConfig.KEY) config: AuthConfig) {` with `  constructor(@Inject(passwordConfig.KEY) config: PasswordConfig) {`.

In the moved `password-hasher.service.spec.ts`, replace:
```ts
import { DomainValidationException } from '@platform/common';
import { authConfig } from '@platform/config';
import { describe, expect, it } from 'vitest';
import { MAX_PASSWORD_LENGTH } from '../auth.constants.js';
import { PasswordHasher } from './password-hasher.service.js';

// Cheap parameters keep the suite fast; production uses the OWASP baseline from config.
const config = authConfig.parse({
  NODE_ENV: 'test',
  ARGON2_MEMORY_COST: '1024',
```
with:
```ts
import { DomainValidationException } from '@platform/common';
import { describe, expect, it } from 'vitest';
import { MAX_PASSWORD_LENGTH } from '../../identity.constants.js';
import { PasswordHasher } from './password-hasher.service.js';
import { passwordConfig } from './password.config.js';

// Cheap parameters keep the suite fast; production uses the OWASP baseline from config.
const config = passwordConfig.parse({
  ARGON2_MEMORY_COST: '1024',
```
and replace `      authConfig.parse({ NODE_ENV: 'test', ARGON2_MEMORY_COST: '2048', ARGON2_TIME_COST: '1' }),` with `      passwordConfig.parse({ ARGON2_MEMORY_COST: '2048', ARGON2_TIME_COST: '1' }),`.

In `domains/identity/src/identity.constants.ts`, replace:
```ts
  /** Argon2 cost grows with input length: bound it well below @platform/auth's hard cap (1024). */
  PASSWORD_MAX_LENGTH: 128,
```
with:
```ts
  /** Argon2 cost grows with input length: stay well below `MAX_PASSWORD_LENGTH` (1024). */
  PASSWORD_MAX_LENGTH: 128,
```
and insert this directly after the closing `} as const;` of `IDENTITY_LIMITS`:
```ts

/** Longest password `PasswordHasher` hashes or verifies (argon2 cost DoS guard, any transport). */
export const MAX_PASSWORD_LENGTH = 1_024;
```

- [ ] **Step 6: Run the moved spec.**

```bash
npx vitest run --project identity password-hasher
```
Expected: PASS (5 tests).

- [ ] **Step 7: Write the failing DI test, switch the importers and drop the hasher from `@platform/auth`.**

In `domains/identity/src/identity-grpc.module.spec.ts`, replace:
```ts
import { IdentityGrpcModule } from './identity-grpc.module.js';
```
with:
```ts
import { IdentityGrpcModule } from './identity-grpc.module.js';
import { PasswordHasher } from './infrastructure/security/password-hasher.service.js';
import { passwordConfig } from './infrastructure/security/password.config.js';
```
Then add this case after the existing `it('a gRPC handler runs the real query handler and repository', …)`:
```ts
  it('hashes with the identity-owned PasswordHasher, configured by the password namespace', async () => {
    const { argon2 } = passwordConfig.parse();
    const hasher = moduleRef.get(PasswordHasher);
    const hash = await hasher.hash('correct horse battery staple');
    expect(hash).toContain(`$m=${argon2.memoryCost},t=${argon2.timeCost},p=${argon2.parallelism}$`);
    await expect(hasher.verify(hash, 'correct horse battery staple')).resolves.toBe(true);
  });
```
Switch the importers:
- `login.handler.ts`: delete `import { PasswordHasher } from '@platform/auth';` and add `import { PasswordHasher } from '../../../infrastructure/security/password-hasher.service.js';`.
- `register-user.handler.ts`: same deletion and addition.
- `login.handler.spec.ts` and `register-user.handler.spec.ts`: replace `import type { PasswordHasher } from '@platform/auth';` with `import type { PasswordHasher } from '../../../infrastructure/security/password-hasher.service.js';`.
- `identity-api.module.spec.ts`: replace `import { PasswordHasher, Role } from '@platform/auth';` with `import { Role } from '@platform/auth';` and add `import { PasswordHasher } from './infrastructure/security/password-hasher.service.js';`.

Drop the hasher from `@platform/auth`:
- `libs/auth/src/auth.module.ts`: delete `import { PasswordHasher } from './password/password-hasher.service.js';`, and delete both `        PasswordHasher,` lines (providers and exports). Replace:
```ts
   * `TokenService` / `PasswordHasher` directly.
```
with:
```ts
   * `TokenService` / `AccessTokenDenylist` directly.
```
Replace:
```ts
 * access-token denylist, Argon2id hashing, the passport `jwt` strategy and the RBAC guards.
```
with:
```ts
 * access-token denylist, the passport `jwt` strategy and the RBAC guards.
```
- `libs/auth/src/auth.module.spec.ts`: delete `import { PasswordHasher } from './password/password-hasher.service.js';`. Replace `it('provides token verification, hashing and the denylist from config', async () => {` with `it('provides token verification and the denylist from config', async () => {`. Delete:
```ts
    const hasher = app.get(PasswordHasher);
    await expect(hasher.verify(await hasher.hash('pw'), 'pw')).resolves.toBe(true);

```
- `libs/auth/src/auth.constants.ts`: delete:
```ts
/** Longest password accepted for hashing/verification (argon2 cost DoS guard). */
export const MAX_PASSWORD_LENGTH = 1_024;

```
- `libs/auth/src/index.ts`: delete the line `  MAX_PASSWORD_LENGTH,` from the `./auth.constants.js` export list, delete `export { PasswordHasher } from './password/password-hasher.service.js';`, and replace ` * refresh tokens, the Redis access-token denylist, Argon2id password hashing and RBAC` with ` * refresh tokens, the Redis access-token denylist and RBAC`.

- [ ] **Step 8: Run it and see the DI fail.**

```bash
npx vitest run --project identity identity-grpc.module identity-api.module
```
Expected: FAIL in both files' `beforeAll` with `Nest can't resolve dependencies of the LoginHandler (UsersRepository, ?, SessionTokensService). Please make sure that the argument PasswordHasher at index [1] is available in the IdentityCoreModule context.` (or the same message for `RegisterUserHandler`).

- [ ] **Step 9: Wire `IdentityCoreModule`.** In `domains/identity/src/identity-core.module.ts`, replace `import { Module, type Provider } from '@nestjs/common';` with:
```ts
import { Module, type Provider } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
```
Replace `import { PurgeExpiredSessionsCron } from './infrastructure/scheduling/purge-expired-sessions.cron.js';` with:
```ts
import { PurgeExpiredSessionsCron } from './infrastructure/scheduling/purge-expired-sessions.cron.js';
import { PasswordHasher } from './infrastructure/security/password-hasher.service.js';
import { passwordConfig } from './infrastructure/security/password.config.js';
```
Replace ` * The identity core: CQRS handlers, the Kafka relay, repositories and the session purge cron.` with:
```ts
 * The identity core: CQRS handlers, the Kafka relay, repositories, the session purge cron and
 * `PasswordHasher` (Argon2id, its own `password` config namespace).
```
Replace:
```ts
 * `RedisModule` (denylist, locks), `AuthModule` (TokenService, PasswordHasher, denylist),
```
with:
```ts
 * `RedisModule` (denylist, locks), `AuthModule` (TokenService, denylist),
```
Replace:
```ts
@Module({
  providers: [
```
with:
```ts
@Module({
  imports: [ConfigModule.forFeature(passwordConfig)],
  providers: [
```
Replace:
```ts
    ...PERSISTENCE,
    SessionTokensService,
```
with:
```ts
    ...PERSISTENCE,
    PasswordHasher,
    SessionTokensService,
```
In `domains/identity/src/index.ts`, add `  MAX_PASSWORD_LENGTH,` to the `./identity.constants.js` export list. Then insert this after the `} from './infrastructure/persistence/identity.schema.js';` line:
```ts
// Infrastructure: identity's security services and their config namespaces (the apps'
// env-example specs validate these namespaces too).
export { PasswordHasher } from './infrastructure/security/password-hasher.service.js';
export { type PasswordConfig, passwordConfig } from './infrastructure/security/password.config.js';
```
In `apps/identity-service/src/app.module.ts`, replace:
```ts
    // TokenService / PasswordHasher / AccessTokenDenylist for the handlers. No global guards:
    // the service only answers the gateway, which authenticates and authorises every request.
```
with:
```ts
    // TokenService / AccessTokenDenylist for the handlers (PasswordHasher comes with
    // IdentityCoreModule). No global guards: the service only answers the gateway, which
    // authenticates and authorises every request.
```

- [ ] **Step 10: Run it.**

```bash
npx vitest run --project identity --project auth
```
Expected: PASS (both projects).

- [ ] **Step 11: Move the native dependency.**
- In `domains/identity/package.json` `dependencies`, insert `"@node-rs/argon2": "catalog:",` after `"@nestjs/swagger": "catalog:",`.
- In `libs/auth/package.json`, delete `    "@node-rs/argon2": "catalog:",`.
- In the `libs/auth/package.json` description, replace `Redis access-token denylist, Argon2id password hashing and RBAC guards/decorators` with `Redis access-token denylist and RBAC guards/decorators`.

Then run:
```bash
bun install
git diff --stat bun.lock
```
Expected: `bun install` succeeds, and `bun.lock` changes only in the `domains/identity` and `libs/auth` workspace entries.

- [ ] **Step 12: Shrink the platform `auth` namespace.** This is D's file: targeted edits only. In `libs/config/src/namespaces/auth.config.ts`, delete:
```ts
    // OWASP 2024 Argon2id baseline: m=19 MiB, t=2, p=1.
    ARGON2_MEMORY_COST: zInt(19_456, { min: 8 }),
    ARGON2_TIME_COST: zInt(2, { min: 1 }),
    ARGON2_PARALLELISM: zInt(1, { min: 1, max: 255 }),
```
and delete:
```ts
    argon2: {
      /** KiB. Hashing runs on the libuv threadpool — size UV_THREADPOOL_SIZE for login bursts. */
      memoryCost: env.ARGON2_MEMORY_COST,
      timeCost: env.ARGON2_TIME_COST,
      parallelism: env.ARGON2_PARALLELISM,
    },
```
and replace `/** JWT signing/verification, token TTLs, Argon2id cost, access-token denylist. */` with `/** JWT signing/verification, token TTLs, access-token denylist. */`.

In `libs/config/src/namespaces/namespaces.spec.ts`, delete `      argon2: { memoryCost: 19_456, timeCost: 2, parallelism: 1 },` from the `authConfig.parse({})` expectation. Replace `    expectTypeOf<AuthConfig['argon2']['memoryCost']>().toEqualTypeOf<number>();` with `    expectTypeOf<AuthConfig['accessTtlSec']>().toEqualTypeOf<number>();`.

Then run:
```bash
npx vitest run --project config
```
Expected: PASS.

- [ ] **Step 13: Update the docs.**
- **`libs/auth/README.md`:**
  - Delete the bullet `- passwords are hashed with Argon2id`.
  - In the `AuthModule.forRootAsync` row, replace `` `TokenService`, `PasswordHasher`, `AccessTokenDenylist`, `` with `` `TokenService`, `AccessTokenDenylist`, ``.
  - Delete the row that starts with `` | `PasswordHasher` ``.
  - In the constants row, replace `` `JWT_CLOCK_TOLERANCE_SEC`, `MAX_PASSWORD_LENGTH` `` with `` `JWT_CLOCK_TOLERANCE_SEC` ``.
  - Replace `// gRPC-only service: no global guards, just issue/verify/hash` with `// gRPC-only service: no global guards, just issue/verify tokens and the denylist`.
  - Delete the bullet that starts with `` - `ARGON2_MEMORY_COST` ``.
  - Replace the whole paragraph that starts with:
    ```markdown
    The Redis keys use the `redis` namespace (`REDIS_KEY_PREFIX`). Argon2 runs on the libuv threadpool
    ```
    with:
    ```markdown
    The Redis keys use the `redis` namespace (`REDIS_KEY_PREFIX`). Password hashing (Argon2id) belongs to the identity context, with its own `password` namespace (`ARGON2_*`).
    ```
  - Delete the gotcha that starts with ``- **Argon2 `Algorithm`.**``.
- **`domains/identity/README.md`:**
  - Replace `│   └── scheduling/         PurgeExpiredSessionsCron (@Cron hourly + @WithLock)` with:
    ```
    │   ├── scheduling/         PurgeExpiredSessionsCron (@Cron hourly + @WithLock)
    │   └── security/           PasswordHasher (Argon2id; password.config.ts: ARGON2_*)
    ```
  - In the `IdentityCoreModule` row, replace `` `SessionTokensService`, cron `` with `` `SessionTokensService`, cron, `PasswordHasher` (`password` namespace) ``.
  - In "## Configuration", replace ``Read through `@platform/config` namespaces: `auth` (`JWT_*`, `ARGON2_*`, `AUTH_DENYLIST_ENABLED`),`` with ``Identity's own `password` namespace (`ARGON2_MEMORY_COST`, `ARGON2_TIME_COST`, `ARGON2_PARALLELISM`; `infrastructure/security/password.config.ts`, loaded by `IdentityCoreModule`) and these `@platform/config` namespaces: `auth` (`JWT_*`, `AUTH_DENYLIST_ENABLED`),``.
  - In "## Tests", after the `- domain: …` bullet, add:
    ```markdown
    - security: `PasswordHasher` (Argon2id parameters, per-hash salt, over-long inputs, rehash detection) and the `password` namespace;
    ```
  - In "## Gotchas", add ``- `@node-rs/argon2`'s `Algorithm` is an ambient const enum with an empty runtime object, so `PasswordHasher` relies on the default (Argon2id) and `needsRehash` compares against the literal `2`. Hashing runs on the libuv threadpool: keep `UV_THREADPOOL_SIZE` at or below the container's CPUs (see [docs/PERFORMANCE.md](../../docs/PERFORMANCE.md)).``
- **`docs/SECURITY.md`:**
  - Replace `(tokens, guards, hashing) and` with `(tokens, guards) and`.
  - Replace `(sessions, rotation, logout).` with `(password hashing, sessions, rotation, logout).`
  - Replace `` (`PasswordHasher`, `libs/auth/src/password/`) `` with `` (`PasswordHasher`, `domains/identity/src/infrastructure/security/`) ``.
  - Replace `` `@platform/auth` bounds the hashing cost of any input. `` with `` `@domain/identity` bounds the hashing cost of any input. ``
- **`docs/CONFIGURATION.md`:**
  - In "## Which app loads which namespace", insert this row after the `` `auth` `` row:
    ```
    | `password` | ✓ | | ✓ | | | `IdentityCoreModule` (`@domain/identity`) |
    ```
  - Replace the heading ``### `auth` — JWT + Argon2id`` with ``### `auth` — JWT``.
  - Delete the three rows `` `ARGON2_MEMORY_COST` ``, `` `ARGON2_TIME_COST` `` and `` `ARGON2_PARALLELISM` `` from the `auth` table.
  - Insert this directly before the heading ``### `throttle` ``:
````markdown
### `password` — Argon2id (identity)

[`password.config.ts`](../domains/identity/src/infrastructure/security/password.config.ts) · monolith,
identity-service (loaded by `IdentityCoreModule`)

| Variable             | Default | Description                                                                                 |
| -------------------- | ------- | ------------------------------------------------------------------------------------------- |
| `ARGON2_MEMORY_COST` | `19456` | KiB (OWASP baseline m = 19 MiB). Hashing runs on the libuv pool (see `UV_THREADPOOL_SIZE`). |
| `ARGON2_TIME_COST`   | `2`     | Iterations.                                                                                 |
| `ARGON2_PARALLELISM` | `1`     | Lanes, `1`–`255`.                                                                           |

````
- **`docs/PERFORMANCE.md:34`:** replace `` `libs/auth/src/password/` `` with `` `domains/identity/src/infrastructure/security/` ``.
- **`docs/ARCHITECTURE.md`:**
  - In the `libs/auth` row, replace ``JWT + RBAC guards, `TokenService`, `PasswordHasher`, access-token denylist`` with ``JWT + RBAC guards, `TokenService`, access-token denylist``.
  - On the line that starts `- Application handlers depend on abstract repository ports`, replace only this substring (the billing lane may edit the Stripe example on the same line):
    ```markdown
    `RegisterUserHandler` injects `PasswordHasher` (`@platform/auth`)
    ```
    with:
    ```markdown
    `LogoutHandler` injects `AccessTokenDenylist` (`@platform/auth`)
    ```
- **`README.md:313`:** replace `# JWT strategy, guards, RBAC, password hashing (Argon2id)` with `# JWT strategy, guards, RBAC, access-token denylist`.
- **`apps/identity-service/README.md`:** replace `` `TokenService`, `PasswordHasher`, `AccessTokenDenylist`; no guards: only the gateway calls it `` with `` `TokenService`, `AccessTokenDenylist`; no guards: only the gateway calls it (`PasswordHasher` comes with `IdentityCoreModule`) ``.
- **`libs/config/README.md`:** in the `auth` row, delete ``, `ARGON2_MEMORY_COST` (19456), `ARGON2_TIME_COST` (2), `ARGON2_PARALLELISM` (1)``.
- **`.env.example`** (D also edits this file): replace `# Argon2id cost (OWASP baseline m=19 MiB, t=2, p=1); hashing runs on the libuv pool (UV_THREADPOOL_SIZE)` with:
  ```
  # Argon2id cost, identity's password namespace (monolith, identity-service): OWASP baseline
  # m=19 MiB, t=2, p=1; hashing runs on the libuv pool (UV_THREADPOOL_SIZE)
  ```

Then run:
```bash
bunx prettier --write libs/auth/README.md domains/identity/README.md docs/SECURITY.md docs/CONFIGURATION.md docs/PERFORMANCE.md docs/ARCHITECTURE.md README.md apps/identity-service/README.md libs/config/README.md
```

- [ ] **Step 14: Run the full verification for this move.**

```bash
bunx biome check --write domains/identity libs/auth libs/config/src apps/identity-service/src/app.module.ts
npx vitest run --project identity --project auth --project config --project billing --project identity-service --project monolith
npx vitest run --project identity-service:e2e --project monolith:e2e
node scripts/check-env-example.mjs
bun run check
git grep -n "PasswordHasher\|MAX_PASSWORD_LENGTH" -- libs
```
Expected:
- Every Vitest project: PASS.
- `check-env-example`: PASS. This needs lane platform's scan of `domains/**/src/**/*.config.ts`. Without it the script prints `.env.example lists ARGON2_MEMORY_COST, which @platform/config does not read`. In that case do not commit; land the platform task first.
- `bun run check`: PASS.
- The grep prints nothing.

- [ ] **Step 15: Commit.**

```bash
git add domains/identity/src/infrastructure/security/password-hasher.service.ts domains/identity/src/infrastructure/security/password-hasher.service.spec.ts domains/identity/src/infrastructure/security/password.config.ts domains/identity/src/infrastructure/security/password.config.spec.ts domains/identity/src/identity.constants.ts domains/identity/src/identity-core.module.ts domains/identity/src/identity-grpc.module.spec.ts domains/identity/src/identity-api.module.spec.ts domains/identity/src/application/commands/login/login.handler.ts domains/identity/src/application/commands/login/login.handler.spec.ts domains/identity/src/application/commands/register-user/register-user.handler.ts domains/identity/src/application/commands/register-user/register-user.handler.spec.ts domains/identity/src/index.ts domains/identity/package.json libs/auth/package.json libs/auth/src/auth.module.ts libs/auth/src/auth.module.spec.ts libs/auth/src/auth.constants.ts libs/auth/src/index.ts libs/config/src/namespaces/auth.config.ts libs/config/src/namespaces/namespaces.spec.ts apps/identity-service/src/app.module.ts bun.lock libs/auth/README.md domains/identity/README.md docs/SECURITY.md docs/CONFIGURATION.md docs/PERFORMANCE.md docs/ARCHITECTURE.md README.md apps/identity-service/README.md libs/config/README.md .env.example
git commit -F - <<'EOF'
refactor(identity): move PasswordHasher and the Argon2 settings into identity

PasswordHasher and MAX_PASSWORD_LENGTH move to
domains/identity/src/infrastructure/security/, with a new `password` config
namespace (ARGON2_MEMORY_COST, ARGON2_TIME_COST, ARGON2_PARALLELISM; env names
unchanged). IdentityCoreModule provides the hasher; AuthModule and the platform
`auth` namespace no longer know about Argon2, and @node-rs/argon2 becomes an
identity dependency.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task identity-5: The `refreshToken` namespace and `TokenIssuer` (additive)

**Files:**
- Create: `domains/identity/src/infrastructure/security/refresh-token.config.ts`
- Test: `domains/identity/src/infrastructure/security/refresh-token.config.spec.ts`
- Create: `domains/identity/src/infrastructure/security/token-issuer.service.ts`
- Test: `domains/identity/src/infrastructure/security/token-issuer.service.spec.ts`
- Modify: `libs/config/src/namespaces/auth.config.ts:11,16,18` (exports the secret minimum; D's file)
- Modify: `libs/config/src/index.ts:12` (re-exports D's `production-guards`, unless D already does)
- Modify: `domains/identity/package.json` (+ `@nestjs/jwt`), `bun.lock`
- Modify: `domains/identity/src/index.ts` (Infrastructure block)
- Modify: `libs/config/README.md:23` (Constants row)

**Interfaces:**
- Consumes:
  - from `@platform/auth`: `AccessTokenSubject`, `IssuedAccessToken`, `IssuedRefreshToken`, `RefreshTokenClaims`, `parseRefreshTokenClaims`, `toUnauthenticated`, `AuthErrorCode`, `JWT_ALGORITHM`, `JWT_CLOCK_TOLERANCE_SEC`, `createJwtModuleOptions`, and `TokenService` (spec only);
  - from `@platform/config`: `authConfig`/`AuthConfig`, `DEV_JWT_ACCESS_SECRET`, `defineConfigNamespace`, `zBool`, `zInt`, `zNodeEnv`, `zStr`, `EnvValidationError`;
  - from D: `isKnownLocalSecret(value: string | undefined): boolean` (`libs/config/src/env/production-guards.ts`) and the `ALLOW_KNOWN_LOCAL_SECRETS` opt-out (`zBool(false)`, read today by the `auth`, `stripe` and `storage` namespaces).
- Produces:
  - from `@platform/config`: `export const MIN_JWT_SECRET_LENGTH = 32`.
  - from `@domain/identity`:
    - `DEV_JWT_REFRESH_SECRET`;
    - `refreshTokenConfig = defineConfigNamespace('refreshToken', refreshTokenEnvSchema)` (KEY `'CONFIGURATION(refreshToken)'`). It reads `JWT_REFRESH_SECRET` and `JWT_REFRESH_TTL_SEC`, plus `JWT_ACCESS_SECRET`, `ALLOW_KNOWN_LOCAL_SECRETS` and `NODE_ENV` for the production guards;
    - `type RefreshTokenConfig = { refreshSecret: string; refreshTtlSec: number }`;
    - `TokenIssuer`, with:
      - `constructor(jwt: JwtService, @Inject(authConfig.KEY) access: AuthConfig, @Inject(refreshTokenConfig.KEY) refresh: RefreshTokenConfig)`;
      - `issueAccessToken(user: AccessTokenSubject): Promise<IssuedAccessToken>`;
      - `issueRefreshToken(input: { userId: string; sessionId: string }): Promise<IssuedRefreshToken>`;
      - `verifyRefreshToken(token: string): Promise<RefreshTokenClaims>`.

      Lane platform constructs it this way when it moves `FakeAuthPort` into `@domain/identity/testing`.

- [ ] **Step 1: Write the failing namespace test.** Create `domains/identity/src/infrastructure/security/refresh-token.config.spec.ts`. These are the refresh-secret guard cases that live in `libs/config` today: `namespaces.spec.ts:305-334` and D's `production-guards.spec.ts:61-83`.

```ts
import { DEV_JWT_ACCESS_SECRET, EnvValidationError } from '@platform/config';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  DEV_JWT_REFRESH_SECRET,
  type RefreshTokenConfig,
  refreshTokenConfig,
} from './refresh-token.config.js';

const PROD = { NODE_ENV: 'production' } as const;
/** The docker-compose fallback for JWT_REFRESH_SECRET (publicly known). */
const COMPOSE_REFRESH_SECRET = 'compose-local-refresh-secret-not-for-production-0002';

const errorOf = (fn: () => unknown): EnvValidationError => {
  try {
    fn();
  } catch (error) {
    if (error instanceof EnvValidationError) return error;
    throw error;
  }
  throw new Error('expected an EnvValidationError');
};

describe('refreshToken config namespace', () => {
  it('defaults to the development secret and a 7-day TTL, never exposing the access secret', () => {
    expect(refreshTokenConfig.parse({})).toEqual({
      refreshSecret: DEV_JWT_REFRESH_SECRET,
      refreshTtlSec: 604_800,
    } satisfies RefreshTokenConfig);
    expect(refreshTokenConfig.KEY).toBe('CONFIGURATION(refreshToken)');
    expectTypeOf<RefreshTokenConfig['refreshSecret']>().toEqualTypeOf<string>();
    expectTypeOf<RefreshTokenConfig['refreshTtlSec']>().toEqualTypeOf<number>();
  });

  it('requires a secret of at least 32 characters in every environment', () => {
    const error = errorOf(() => refreshTokenConfig.parse({ JWT_REFRESH_SECRET: 'short' }));
    expect(error.namespace).toBe('refreshToken');
    expect(error.message).toContain('→ at JWT_REFRESH_SECRET');
  });

  it('rejects the development default in production, even with the opt-out', () => {
    const error = errorOf(() =>
      refreshTokenConfig.parse({ ...PROD, ALLOW_KNOWN_LOCAL_SECRETS: 'true' }),
    );
    expect(error.message).toContain('→ at JWT_REFRESH_SECRET');
    expect(error.message).toContain('development default');
    expect(error.message).not.toContain(DEV_JWT_REFRESH_SECRET);
  });

  it('rejects the compose fallback in production unless ALLOW_KNOWN_LOCAL_SECRETS', () => {
    const env = { ...PROD, JWT_REFRESH_SECRET: COMPOSE_REFRESH_SECRET };
    expect(errorOf(() => refreshTokenConfig.parse(env)).message).toContain(
      'ALLOW_KNOWN_LOCAL_SECRETS',
    );
    expect(
      refreshTokenConfig.parse({ ...env, ALLOW_KNOWN_LOCAL_SECRETS: 'true' }).refreshSecret,
    ).toBe(COMPOSE_REFRESH_SECRET);
  });

  it('rejects a refresh secret equal to the access secret in production', () => {
    const same = 's'.repeat(48);
    const error = errorOf(() =>
      refreshTokenConfig.parse({ ...PROD, JWT_ACCESS_SECRET: same, JWT_REFRESH_SECRET: same }),
    );
    expect(error.message).toContain('→ at JWT_REFRESH_SECRET');
    expect(error.message).toContain('must differ');
  });

  it('accepts a strong distinct secret in production and the dev default elsewhere', () => {
    expect(
      refreshTokenConfig.parse({
        ...PROD,
        JWT_ACCESS_SECRET: 'a'.repeat(48),
        JWT_REFRESH_SECRET: 'b'.repeat(48),
      }).refreshSecret,
    ).toBe('b'.repeat(48));
    expect(refreshTokenConfig.parse({ NODE_ENV: 'test' }).refreshSecret).toBe(
      DEV_JWT_REFRESH_SECRET,
    );
    // The access secret is only compared here; the platform `auth` namespace owns its rules.
    expect(() =>
      refreshTokenConfig.parse({ JWT_ACCESS_SECRET: DEV_JWT_ACCESS_SECRET }),
    ).not.toThrow();
  });
});
```

- [ ] **Step 2: Run it and see it fail.**

```bash
npx vitest run --project identity refresh-token.config
```
Expected: FAIL with `Failed to load url ./refresh-token.config.js … Does the file exist?`

- [ ] **Step 3: Expose the platform pieces and create the namespace.**

In `libs/config/src/namespaces/auth.config.ts` (D's file), replace `const MIN_SECRET_LENGTH = 32;` with:
```ts
/** Every HS256 JWT secret (access and refresh) is at least this long, in every environment. */
export const MIN_JWT_SECRET_LENGTH = 32;
```
and replace both occurrences of `{ min: MIN_SECRET_LENGTH }` with `{ min: MIN_JWT_SECRET_LENGTH }`.

Run `grep -n "production-guards" libs/config/src/index.ts`. If it prints nothing, replace `export * from './env/parse-env.js';` with:
```ts
export * from './env/parse-env.js';
export * from './env/production-guards.js';
```

**D reconciliation:** open `libs/config/src/namespaces/auth.config.ts` as D committed it. The superRefine below must reproduce, for `JWT_REFRESH_SECRET`, exactly the checks D's `authEnvSchema.superRefine` applies to it: the dev-default rejection, the known-local-value rejection gated by `ALLOW_KNOWN_LOCAL_SECRETS`, and the must-differ rule. Keep D's message texts and helper names. The code below matches D's working tree on 2026-10-12.

Create `domains/identity/src/infrastructure/security/refresh-token.config.ts`:
```ts
import type { ConfigType } from '@nestjs/config';
import {
  DEV_JWT_ACCESS_SECRET,
  defineConfigNamespace,
  isKnownLocalSecret,
  MIN_JWT_SECRET_LENGTH,
  zBool,
  zInt,
  zNodeEnv,
  zStr,
} from '@platform/config';
import { z } from 'zod';

/** Development-only default so `bun run dev` works with zero `.env`. Rejected in production. */
export const DEV_JWT_REFRESH_SECRET = 'dev-refresh-secret-change-me-please-32chars';

/**
 * Identity's refresh-token settings. Only the processes that run `IdentityCoreModule` (monolith,
 * identity-service) load this namespace, so edge verifiers never hold the refresh secret. Its
 * production guards are the ones the platform `auth` namespace applies to the access secret.
 */
export const refreshTokenEnvSchema = z
  .object({
    NODE_ENV: zNodeEnv(),
    JWT_REFRESH_SECRET: zStr(DEV_JWT_REFRESH_SECRET, { min: MIN_JWT_SECRET_LENGTH }),
    JWT_REFRESH_TTL_SEC: zInt(604_800, { min: 1 }),
    // Read only for the must-differ guard below (same default as `auth`, so the comparison sees
    // the value the access verifier uses); the `auth` namespace validates it.
    JWT_ACCESS_SECRET: zStr(DEV_JWT_ACCESS_SECRET),
    // LOCAL compose stack only: accept the publicly known compose fallbacks in production mode.
    ALLOW_KNOWN_LOCAL_SECRETS: zBool(false),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;
    if (env.JWT_REFRESH_SECRET === DEV_JWT_REFRESH_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['JWT_REFRESH_SECRET'],
        message:
          'JWT_REFRESH_SECRET must be set to a strong, unique secret in production (the development default is not allowed)',
      });
    } else if (!env.ALLOW_KNOWN_LOCAL_SECRETS && isKnownLocalSecret(env.JWT_REFRESH_SECRET)) {
      ctx.addIssue({
        code: 'custom',
        path: ['JWT_REFRESH_SECRET'],
        message:
          'JWT_REFRESH_SECRET is a publicly known local value (a docker-compose fallback or a placeholder): set a strong, unique secret in production, or ALLOW_KNOWN_LOCAL_SECRETS=true for the local compose stack only',
      });
    }
    // A shared secret would let a refresh token verify as an access token (and vice versa).
    if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['JWT_REFRESH_SECRET'],
        message: 'JWT_REFRESH_SECRET must differ from JWT_ACCESS_SECRET in production',
      });
    }
  })
  .transform((env) => ({
    refreshSecret: env.JWT_REFRESH_SECRET,
    refreshTtlSec: env.JWT_REFRESH_TTL_SEC,
  }));

/** Refresh-token signing and verification (identity only): secret and TTL. */
export const refreshTokenConfig = defineConfigNamespace('refreshToken', refreshTokenEnvSchema);
export type RefreshTokenConfig = ConfigType<typeof refreshTokenConfig>;
```

- [ ] **Step 4: Run it.**

```bash
npx vitest run --project identity refresh-token.config
npx vitest run --project config
```
Expected: PASS (6 tests); `config` PASS, so the rename broke nothing.

- [ ] **Step 5: Write the failing issuer test.** These are the issuance cases from `libs/auth/src/tokens/token.service.spec.ts:34-118`, now cross-checked against the platform verifier. Create `domains/identity/src/infrastructure/security/token-issuer.service.spec.ts`:

```ts
import { JwtService } from '@nestjs/jwt';
import { createJwtModuleOptions, Permission, Role, TokenService } from '@platform/auth';
import { isUuidV7, UnauthenticatedException } from '@platform/common';
import { authConfig } from '@platform/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { refreshTokenConfig } from './refresh-token.config.js';
import { TokenIssuer } from './token-issuer.service.js';

const access = authConfig.parse({ NODE_ENV: 'test', JWT_ACCESS_TTL_SEC: '900' });
const refresh = refreshTokenConfig.parse({ NODE_ENV: 'test', JWT_REFRESH_TTL_SEC: '3600' });
const jwt = new JwtService();
const issuer = new TokenIssuer(jwt, access, refresh);
/** The verifier every edge runs (JwtStrategy and the WS/subscription helpers share its settings). */
const verifier = new TokenService(new JwtService(createJwtModuleOptions(access)), access);
const user = { id: '0190f3b2-0000-7000-8000-000000000001', email: 'a@b.c', roles: [Role.User] };

async function authErrorOf(promise: Promise<unknown>): Promise<UnauthenticatedException> {
  const error: unknown = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(UnauthenticatedException);
  return error as UnauthenticatedException;
}

describe('TokenIssuer', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('issues an HS256 access token the platform verifier accepts (iss/aud/typ, uuidv7 jti)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const issued = await issuer.issueAccessToken(user);
    const now = Math.floor(Date.now() / 1_000);
    expect(issued.expiresIn).toBe(900);
    expect(issued.exp).toBe(now + 900);
    expect(isUuidV7(issued.jti)).toBe(true);

    const header = jwt.decode<{ header: { alg: string } }>(issued.token, { complete: true }).header;
    expect(header.alg).toBe('HS256');
    const claims = await verifier.verifyAccessToken(issued.token);
    expect(claims).toEqual({
      sub: user.id,
      email: 'a@b.c',
      roles: [Role.User],
      typ: 'access',
      jti: issued.jti,
      iat: now,
      exp: now + 900,
      iss: 'nestjs-boilerplate',
      aud: 'nestjs-boilerplate',
    });
    expect(verifier.toAuthUser(claims)).toMatchObject({
      id: user.id,
      jti: issued.jti,
      exp: issued.exp,
      permissions: expect.arrayContaining([Permission.BillingCheckout]),
    });
  });

  it('issues refresh tokens whose jti is the session id, and verifies them', async () => {
    const issued = await issuer.issueRefreshToken({ userId: user.id, sessionId: 'session-1' });
    const claims = await issuer.verifyRefreshToken(issued.token);
    expect(claims).toMatchObject({ sub: user.id, jti: 'session-1', typ: 'refresh' });
    expect(issued.expiresAt.getTime()).toBe(claims.exp * 1_000);
    expect(claims.exp - claims.iat).toBe(3_600);
  });

  it('never accepts one token type as the other', async () => {
    const accessToken = await issuer.issueAccessToken(user);
    const refreshToken = await issuer.issueRefreshToken({ userId: user.id, sessionId: 's' });
    // Different secrets → signature mismatch …
    expect((await authErrorOf(issuer.verifyRefreshToken(accessToken.token))).code).toBe(
      'INVALID_TOKEN',
    );
    expect((await authErrorOf(verifier.verifyAccessToken(refreshToken.token))).code).toBe(
      'INVALID_TOKEN',
    );
    // … and even with the refresh secret, iss and aud the `typ` claim is enforced.
    const forged = await jwt.signAsync(
      { sub: user.id, jti: 's', typ: 'access', email: 'a@b.c', roles: [] },
      {
        secret: refresh.refreshSecret,
        expiresIn: 60,
        issuer: access.issuer,
        audience: access.audience,
      },
    );
    const typMismatch = await authErrorOf(issuer.verifyRefreshToken(forged));
    expect(typMismatch.code).toBe('INVALID_TOKEN');
    expect(typMismatch.details).toEqual({ reason: 'expected a refresh token' });
  });

  it('reports refresh expiry distinctly (TOKEN_EXPIRED) after the 5 s clock tolerance', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const { token } = await issuer.issueRefreshToken({ userId: user.id, sessionId: 's' });
    vi.setSystemTime(Date.now() + (3_600 + 4) * 1_000);
    await expect(issuer.verifyRefreshToken(token)).resolves.toMatchObject({ jti: 's' });
    vi.setSystemTime(Date.now() + 2 * 1_000);
    expect((await authErrorOf(issuer.verifyRefreshToken(token))).code).toBe('TOKEN_EXPIRED');
  });

  it('rejects refresh tokens of another issuer, audience or secret, and empty ones', async () => {
    const foreignIssuer = new TokenIssuer(
      jwt,
      authConfig.parse({ NODE_ENV: 'test', JWT_ISSUER: 'someone-else', JWT_AUDIENCE: 'other-app' }),
      refresh,
    );
    const foreign = await foreignIssuer.issueRefreshToken({ userId: user.id, sessionId: 's' });
    expect((await authErrorOf(issuer.verifyRefreshToken(foreign.token))).code).toBe(
      'INVALID_TOKEN',
    );

    const otherSecret = new TokenIssuer(
      jwt,
      access,
      refreshTokenConfig.parse({ NODE_ENV: 'test', JWT_REFRESH_SECRET: 'r'.repeat(40) }),
    );
    const resigned = await otherSecret.issueRefreshToken({ userId: user.id, sessionId: 's' });
    expect((await authErrorOf(issuer.verifyRefreshToken(resigned.token))).code).toBe(
      'INVALID_TOKEN',
    );

    expect((await authErrorOf(issuer.verifyRefreshToken(''))).code).toBe('MISSING_TOKEN');
  });
});
```

- [ ] **Step 6: Run it and see it fail.**

```bash
npx vitest run --project identity token-issuer
```
Expected: FAIL with `Failed to load url ./token-issuer.service.js … Does the file exist?`

- [ ] **Step 7: Implement the issuer and declare `@nestjs/jwt`.** In `domains/identity/package.json` `dependencies`, insert `"@nestjs/jwt": "catalog:",` after `"@nestjs/graphql": "catalog:",`, then run `bun install`. Create `domains/identity/src/infrastructure/security/token-issuer.service.ts`. Its signing options are copied from `libs/auth/src/tokens/token.service.ts:58-85,110-131`, so the tokens are byte-for-byte the same as today's.

```ts
import { Inject, Injectable } from '@nestjs/common';
import { JwtService, type JwtSignOptions } from '@nestjs/jwt';
import {
  type AccessTokenSubject,
  AuthErrorCode,
  type IssuedAccessToken,
  type IssuedRefreshToken,
  JWT_ALGORITHM,
  JWT_CLOCK_TOLERANCE_SEC,
  parseRefreshTokenClaims,
  type RefreshTokenClaims,
  toUnauthenticated,
} from '@platform/auth';
import { generateId, UnauthenticatedException } from '@platform/common';
import { type AuthConfig, authConfig } from '@platform/config';
import { type RefreshTokenConfig, refreshTokenConfig } from './refresh-token.config.js';

const nowSec = (): number => Math.floor(Date.now() / 1_000);

/**
 * Signs identity's token pair and verifies refresh tokens (HS256, `iss`/`aud` checked, `typ`
 * claim checked, uuidv7 `jti`). Access tokens use the platform `auth` namespace (`JWT_ACCESS_*`,
 * shared with every verifier: `TokenService`, `JwtStrategy`, the WS helpers); refresh tokens use
 * identity's own `refreshToken` namespace, which edge processes never load. `iat`/`exp` are set
 * explicitly from one clock read so the returned `exp` is exactly the token's.
 */
@Injectable()
export class TokenIssuer {
  constructor(
    private readonly jwt: JwtService,
    @Inject(authConfig.KEY) private readonly access: AuthConfig,
    @Inject(refreshTokenConfig.KEY) private readonly refresh: RefreshTokenConfig,
  ) {}

  async issueAccessToken(user: AccessTokenSubject): Promise<IssuedAccessToken> {
    const iat = nowSec();
    const exp = iat + this.access.accessTtlSec;
    const jti = generateId();
    const payload = {
      sub: user.id,
      email: user.email,
      roles: [...user.roles],
      typ: 'access',
      jti,
      iat,
      exp,
    };
    const token = await this.jwt.signAsync(payload, this.signOptions(this.access.accessSecret));
    return { token, jti, expiresIn: this.access.accessTtlSec, exp };
  }

  /** `sessionId` becomes the `jti` (the sessions table stores sha256(token) under that id). */
  async issueRefreshToken(input: {
    userId: string;
    sessionId: string;
  }): Promise<IssuedRefreshToken> {
    const iat = nowSec();
    const exp = iat + this.refresh.refreshTtlSec;
    const payload = { sub: input.userId, jti: input.sessionId, typ: 'refresh', iat, exp };
    const token = await this.jwt.signAsync(payload, this.signOptions(this.refresh.refreshSecret));
    return { token, expiresAt: new Date(exp * 1_000) };
  }

  /** Throws `UnauthenticatedException` (`MISSING_TOKEN` / `TOKEN_EXPIRED` / `INVALID_TOKEN`). */
  async verifyRefreshToken(token: string): Promise<RefreshTokenClaims> {
    return parseRefreshTokenClaims(await this.verify(token));
  }

  private signOptions(secret: string): JwtSignOptions {
    return {
      secret,
      algorithm: JWT_ALGORITHM,
      issuer: this.access.issuer,
      audience: this.access.audience,
    };
  }

  private async verify(token: string): Promise<unknown> {
    if (token.length === 0) {
      throw new UnauthenticatedException('Missing token', { code: AuthErrorCode.MISSING_TOKEN });
    }
    try {
      return await this.jwt.verifyAsync<Record<string, unknown>>(token, {
        secret: this.refresh.refreshSecret,
        algorithms: [JWT_ALGORITHM],
        issuer: this.access.issuer,
        audience: this.access.audience,
        clockTolerance: JWT_CLOCK_TOLERANCE_SEC,
      });
    } catch (error) {
      throw toUnauthenticated(error);
    }
  }
}
```

- [ ] **Step 8: Run it.**

```bash
npx vitest run --project identity token-issuer
```
Expected: PASS (5 tests).

- [ ] **Step 9: Export and document.** In `domains/identity/src/index.ts`, after the `passwordConfig` export added in Task identity-4, add:
```ts
export {
  DEV_JWT_REFRESH_SECRET,
  type RefreshTokenConfig,
  refreshTokenConfig,
} from './infrastructure/security/refresh-token.config.js';
export { TokenIssuer } from './infrastructure/security/token-issuer.service.js';
```
In the `libs/config/README.md` Constants row, replace `` `DEV_JWT_ACCESS_SECRET`, `DEV_JWT_REFRESH_SECRET` `` with `` `DEV_JWT_ACCESS_SECRET`, `DEV_JWT_REFRESH_SECRET`, `MIN_JWT_SECRET_LENGTH` ``. Then run `bunx prettier --write libs/config/README.md`.

- [ ] **Step 10: Run the affected projects and the repo checks.**

```bash
bunx biome check --write domains/identity libs/config/src
npx vitest run --project identity --project config
node scripts/check-env-example.mjs
bun run check
```
Expected:
- Vitest: PASS.
- `check-env-example`: PASS. Every key of `refresh-token.config.ts` is already documented in `.env.example`. As in Task identity-4, this needs lane platform's domain scan; without it the script still reports `ARGON2_*` as unknown.
- `bun run check`: PASS. `@nestjs/jwt` is now declared, so Biome's `noUndeclaredDependencies` passes.

`git diff --stat bun.lock` shows only the `domains/identity` entry.

- [ ] **Step 11: Commit.**

```bash
git add domains/identity/src/infrastructure/security/refresh-token.config.ts domains/identity/src/infrastructure/security/refresh-token.config.spec.ts domains/identity/src/infrastructure/security/token-issuer.service.ts domains/identity/src/infrastructure/security/token-issuer.service.spec.ts domains/identity/src/index.ts domains/identity/package.json bun.lock libs/config/src/namespaces/auth.config.ts libs/config/src/index.ts libs/config/README.md
git commit -F - <<'EOF'
refactor(identity): add TokenIssuer and the refreshToken config namespace

TokenIssuer signs the access/refresh pair and verifies refresh tokens with
the same options TokenService uses today; refreshTokenConfig carries
JWT_REFRESH_SECRET/JWT_REFRESH_TTL_SEC with the production guards (dev
default, known local values, must differ from the access secret). Nothing is
wired yet. @platform/config exports MIN_JWT_SECRET_LENGTH.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task identity-6: Identity issues its own tokens (wiring, handlers, gateway fake)

**Files:**
- Test: `domains/identity/src/identity-grpc.module.spec.ts` (new DI case)
- Modify: `domains/identity/src/identity-core.module.ts` (imports, provider, docstring)
- Modify: `domains/identity/src/application/services/session-tokens.service.ts:2,20`, and its spec `session-tokens.service.spec.ts:1,11,16`
- Modify: `domains/identity/src/application/commands/logout/logout.handler.ts:3,13`, and its spec `logout.handler.spec.ts:1,11,17`
- Modify: `domains/identity/src/application/commands/refresh-session/refresh-session.handler.ts:3,37`, and its spec `refresh-session.handler.spec.ts:1,49,59`
- Modify: `domains/identity/test/mocks.ts:4` (comment)
- Modify: `apps/gateway/test/support/fake-upstreams.ts:1-9,32-33,60`, `apps/gateway/test/support/gateway-e2e-app.ts:1-8,44-59`, `apps/gateway/package.json` (devDependency `@nestjs/jwt`), `bun.lock`
- Modify: `apps/identity-service/src/app.module.ts` (comment)
- Modify (docs): `domains/identity/README.md`, `apps/identity-service/README.md:27`

**Interfaces:**
- Consumes: `TokenIssuer` and `refreshTokenConfig` (Task identity-5); `TokenService`, `AccessTokenDenylist` and `Role` from `@platform/auth`; `authConfig` from `@platform/config`.
- Produces:
  - `IdentityCoreModule` imports `ConfigModule.forFeature(passwordConfig)`, `ConfigModule.forFeature(authConfig)`, `ConfigModule.forFeature(refreshTokenConfig)` and `JwtModule.register({})`, and provides `PasswordHasher` and `TokenIssuer`;
  - `SessionTokensService`, `LogoutHandler` and `RefreshSessionHandler` inject `TokenIssuer`;
  - the gateway e2e fake becomes `new FakeAuthPort(state: FakeIdentityState, tokens: TokenIssuer, denylist: AccessTokenDenylist)`.
  - App wiring. No provider or import changes in `apps/monolith/src/app.module.ts` or `apps/identity-service/src/app.module.ts`, apart from the comment edited in Step 9:
    - both apps reach `IdentityCoreModule` transitively, through `IdentityApiModule.forLocal()` and `IdentityGrpcModule`, so they get `PasswordHasher` and `TokenIssuer` from it;
    - identity-service keeps `AuthModule.forRootAsync({ globalGuards: false })` for `AccessTokenDenylist` (`LogoutHandler`);
    - the monolith keeps `AuthModule.forRootAsync()` for the global guards;
    - the gateway (`IdentityApiModule.forRemote()`, no `IdentityCoreModule`) stops loading `JWT_REFRESH_*` and `ARGON2_*`.

- [ ] **Step 1: Write the failing DI test.** In `domains/identity/src/identity-grpc.module.spec.ts`, replace `import { AuthModule } from '@platform/auth';` with `import { AuthModule, Role, TokenService } from '@platform/auth';` and add `import { TokenIssuer } from './infrastructure/security/token-issuer.service.js';`. Then append this case inside the `describe`:

```ts
  it('issues tokens with the identity-owned TokenIssuer; the platform verifier accepts them', async () => {
    const issuer = moduleRef.get(TokenIssuer);
    const access = await issuer.issueAccessToken({
      id: USER_ID,
      email: 'ada@example.com',
      roles: [Role.User],
    });
    await expect(moduleRef.get(TokenService).verifyAccessToken(access.token)).resolves.toMatchObject(
      { sub: USER_ID, typ: 'access' },
    );
    const refresh = await issuer.issueRefreshToken({ userId: USER_ID, sessionId: 'session-1' });
    await expect(issuer.verifyRefreshToken(refresh.token)).resolves.toMatchObject({
      sub: USER_ID,
      jti: 'session-1',
    });
  });
```

- [ ] **Step 2: Run it and see it fail.**

```bash
npx vitest run --project identity identity-grpc.module
```
Expected: FAIL in the new case with `Nest could not find TokenIssuer element (this provider does not exist in the current context)`.

- [ ] **Step 3: Wire `IdentityCoreModule`.** In `domains/identity/src/identity-core.module.ts`, replace:
```ts
import { ConfigModule } from '@nestjs/config';
```
with:
```ts
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { authConfig } from '@platform/config';
```
Replace `import { passwordConfig } from './infrastructure/security/password.config.js';` with:
```ts
import { passwordConfig } from './infrastructure/security/password.config.js';
import { refreshTokenConfig } from './infrastructure/security/refresh-token.config.js';
import { TokenIssuer } from './infrastructure/security/token-issuer.service.js';
```
Replace:
```ts
 * The identity core: CQRS handlers, the Kafka relay, repositories, the session purge cron and
 * `PasswordHasher` (Argon2id, its own `password` config namespace).
```
with:
```ts
 * The identity core: CQRS handlers, the Kafka relay, repositories, the session purge cron and
 * identity's security services: `PasswordHasher` (`password` namespace) and `TokenIssuer` (its own
 * `JwtModule`; `auth` + `refreshToken` namespaces).
```
Replace:
```ts
 * `RedisModule` (denylist, locks), `AuthModule` (TokenService, denylist),
```
with:
```ts
 * `RedisModule` (denylist, locks), `AuthModule` (the access-token denylist),
```
Replace:
```ts
  imports: [ConfigModule.forFeature(passwordConfig)],
```
with:
```ts
  imports: [
    ConfigModule.forFeature(passwordConfig),
    // TokenIssuer: the access-token settings stay in the platform `auth` namespace (every verifier
    // reads them); the refresh secret and TTL are identity's own. Every sign/verify call passes
    // its secret, algorithm, iss and aud, so this JwtModule carries no defaults.
    ConfigModule.forFeature(authConfig),
    ConfigModule.forFeature(refreshTokenConfig),
    JwtModule.register({}),
  ],
```
Replace:
```ts
    PasswordHasher,
    SessionTokensService,
```
with:
```ts
    PasswordHasher,
    TokenIssuer,
    SessionTokensService,
```

- [ ] **Step 4: Run it.**

```bash
npx vitest run --project identity identity-grpc.module
```
Expected: PASS.

- [ ] **Step 5: Switch the handlers and their specs.**
- `session-tokens.service.ts`: delete `import { TokenService } from '@platform/auth';`, add `import { TokenIssuer } from '../../infrastructure/security/token-issuer.service.js';`, and replace `    private readonly tokens: TokenService,` with `    private readonly tokens: TokenIssuer,`.
- `session-tokens.service.spec.ts`: replace `import type { TokenService } from '@platform/auth';` with `import type { TokenIssuer } from '../../infrastructure/security/token-issuer.service.js';`, and replace both `mockOf<TokenService>` with `mockOf<TokenIssuer>`.
- `logout.handler.ts`: replace `import { AccessTokenDenylist, TokenService } from '@platform/auth';` with `import { AccessTokenDenylist } from '@platform/auth';`, add `import { TokenIssuer } from '../../../infrastructure/security/token-issuer.service.js';`, and replace `    private readonly tokens: TokenService,` with `    private readonly tokens: TokenIssuer,`.
- `logout.handler.spec.ts`: replace `import type { AccessTokenDenylist, TokenService } from '@platform/auth';` with `import type { AccessTokenDenylist } from '@platform/auth';`, add `import type { TokenIssuer } from '../../../infrastructure/security/token-issuer.service.js';`, and replace both `mockOf<TokenService>` with `mockOf<TokenIssuer>`.
- `refresh-session.handler.ts`: replace `import { AuthErrorCode, type RefreshTokenClaims, TokenService } from '@platform/auth';` with `import { AuthErrorCode, type RefreshTokenClaims } from '@platform/auth';`, add `import { TokenIssuer } from '../../../infrastructure/security/token-issuer.service.js';`, and replace `    private readonly tokens: TokenService,` with `    private readonly tokens: TokenIssuer,`.
- `refresh-session.handler.spec.ts`: replace `import { AuthErrorCode, type RefreshTokenClaims, type TokenService } from '@platform/auth';` with `import { AuthErrorCode, type RefreshTokenClaims } from '@platform/auth';`, add `import type { TokenIssuer } from '../../../infrastructure/security/token-issuer.service.js';`, and replace both `mockOf<TokenService>` with `mockOf<TokenIssuer>`.
- `domains/identity/test/mocks.ts`: replace:
```ts
 * `createMock<T>()` typed as `Mocked<T> & T`: classes with private members (TokenService,
```
with:
```ts
 * `createMock<T>()` typed as `Mocked<T> & T`: classes with private members (TokenIssuer,
```

- [ ] **Step 6: Run the identity project.**

```bash
npx vitest run --project identity
```
Expected: PASS. This includes `identity-api.module.spec.ts:103-138`: register → a `TokenIssuer` token is accepted by the real global guards.

- [ ] **Step 7: Make the gateway's fake identity-service sign with `TokenIssuer`.** **Execution-time rule:** if lane platform has already moved `FakeAuthPort` into `domains/identity/src/testing/`, make the same edits there, importing `TokenIssuer` relatively.

In `apps/gateway/test/support/fake-upstreams.ts`, replace:
```ts
  normalizeEmail,
  UsersPort,
} from '@domain/identity';
```
with:
```ts
  normalizeEmail,
  type TokenIssuer,
  UsersPort,
} from '@domain/identity';
```
Replace `import { type AccessTokenDenylist, isRole, type TokenService } from '@platform/auth';` with `import { type AccessTokenDenylist, isRole } from '@platform/auth';`. Replace:
```ts
 * Tokens are signed with the gateway's own TokenService: in production identity-service signs them
 * with the same JWT_ACCESS_SECRET, which is what lets the gateway verify them locally.
```
with:
```ts
 * Tokens are signed by identity's real `TokenIssuer`, built from the same env as the gateway's
 * verifier: in production identity-service signs them with the shared JWT_ACCESS_SECRET, which is
 * what lets the gateway verify them locally.
```
Replace `    private readonly tokens: TokenService,` with `    private readonly tokens: TokenIssuer,`.

In `apps/gateway/test/support/gateway-e2e-app.ts`, replace `import { AuthPort, UsersPort } from '@domain/identity';` with `import { AuthPort, refreshTokenConfig, TokenIssuer, UsersPort } from '@domain/identity';`. Replace `import { CACHE_MANAGER } from '@nestjs/cache-manager';` with:
```ts
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { JwtService } from '@nestjs/jwt';
```
Replace `import { AccessTokenDenylist, TokenService } from '@platform/auth';` with `import { AccessTokenDenylist } from '@platform/auth';`. Replace `import { appConfig } from '@platform/config';` with `import { appConfig, authConfig } from '@platform/config';`. Replace:
```ts
  const storage = new InMemoryStorageService();

```
with:
```ts
  const storage = new InMemoryStorageService();
  // identity-service's signer, built from the env the gateway's AuthModule verifies with.
  const issuer = new TokenIssuer(new JwtService(), authConfig.parse(), refreshTokenConfig.parse());

```
Replace:
```ts
    .useFactory({
      factory: (tokens: TokenService, denylist: AccessTokenDenylist) =>
        new FakeAuthPort(identity, tokens, denylist),
      inject: [TokenService, AccessTokenDenylist],
    })
```
with:
```ts
    .useFactory({
      factory: (denylist: AccessTokenDenylist) => new FakeAuthPort(identity, issuer, denylist),
      inject: [AccessTokenDenylist],
    })
```
In the `apps/gateway/package.json` `devDependencies`, insert `"@nestjs/jwt": "catalog:",` before `"@nestjs/testing": "catalog:",`, then run `bun install`.

- [ ] **Step 8: Run the gateway e2e.**

```bash
npx vitest run --project gateway:e2e
```
Expected: PASS. This includes `POST /v1/auth/refresh → a new pair`, which proves that the fake's refresh JWTs pass `@IsJWT()` and `TokenIssuer.verifyRefreshToken`.

- [ ] **Step 9: Update the comments and docs.**
- In `apps/identity-service/src/app.module.ts`, replace:
```ts
    // TokenService / AccessTokenDenylist for the handlers (PasswordHasher comes with
    // IdentityCoreModule). No global guards: the service only answers the gateway, which
    // authenticates and authorises every request.
```
with:
```ts
    // AccessTokenDenylist for LogoutHandler (PasswordHasher and TokenIssuer come with
    // IdentityCoreModule). No global guards: the service only answers the gateway, which
    // authenticates and authorises every request.
```
- **`domains/identity/README.md`:**
  - Replace `│   └── security/           PasswordHasher (Argon2id; password.config.ts: ARGON2_*)` with:
    ```
    │   └── security/           PasswordHasher (Argon2id; password.config.ts), TokenIssuer (access + refresh
    │                           JWTs, refresh verification; refresh-token.config.ts)
    ```
  - In the `IdentityCoreModule` row, replace ``cron, `PasswordHasher` (`password` namespace)`` with ``cron, `PasswordHasher` (`password` namespace), `TokenIssuer` (own `JwtModule`; `auth` + `refreshToken` namespaces)``.
  - Replace:
    ```
    - **Tokens**: access JWT (15 min, HS256, `jti` uuidv7) and refresh JWT (7 d, separate secret,
      `jti` = session id). The `sessions` row stores `sha256(refreshToken)` only.
    ```
    with:
    ```
    - **Tokens**: `TokenIssuer` signs the access JWT (15 min, HS256, `jti` uuidv7; `JWT_ACCESS_*` from
      the platform `auth` namespace that every verifier shares) and the refresh JWT (7 d, its own
      secret from identity's `refreshToken` namespace, `jti` = session id), and verifies refresh
      tokens. The `sessions` row stores `sha256(refreshToken)` only.
    ```
  - Replace ``Identity's own `password` namespace (`ARGON2_MEMORY_COST`, `ARGON2_TIME_COST`, `ARGON2_PARALLELISM`; `infrastructure/security/password.config.ts`, loaded by `IdentityCoreModule`) and these `@platform/config` namespaces: `auth` (`JWT_*`, `AUTH_DENYLIST_ENABLED`),`` with ``Identity's own namespaces, loaded by `IdentityCoreModule` (`infrastructure/security/`): `password` (`ARGON2_MEMORY_COST`, `ARGON2_TIME_COST`, `ARGON2_PARALLELISM`) and `refreshToken` (`JWT_REFRESH_SECRET`, `JWT_REFRESH_TTL_SEC`; it reads `JWT_ACCESS_SECRET` only for the production must-differ check). From `@platform/config`: `auth` (`JWT_ACCESS_*`, `JWT_ISSUER`/`JWT_AUDIENCE`, `AUTH_DENYLIST_ENABLED`),``.
  - Replace ``- security: `PasswordHasher` (Argon2id parameters, per-hash salt, over-long inputs, rehash detection) and the `password` namespace;`` with ``- security: `PasswordHasher` (Argon2id parameters, per-hash salt, over-long inputs, rehash detection), `TokenIssuer` (claims accepted by the platform `TokenService`, refresh verification, `typ` cross-check, expiry) and the `password` / `refreshToken` namespaces (defaults, production guards);``.
- **`apps/identity-service/README.md`:** replace `` `TokenService`, `AccessTokenDenylist`; no guards: only the gateway calls it (`PasswordHasher` comes with `IdentityCoreModule`) `` with `` `AccessTokenDenylist` (logout); no guards: only the gateway calls it (`PasswordHasher` and `TokenIssuer` come with `IdentityCoreModule`) ``.

Then run `bunx prettier --write domains/identity/README.md apps/identity-service/README.md`.

- [ ] **Step 10: Run the affected projects and the repo checks.**

```bash
bunx biome check --write domains/identity apps/gateway apps/identity-service/src/app.module.ts
npx vitest run --project identity --project billing --project gateway --project identity-service --project monolith
npx vitest run --project gateway:e2e --project identity-service:e2e --project monolith:e2e
bun run check
git grep -n "TokenService" -- domains/identity/src apps/gateway/test
```
Expected:
- Vitest: PASS for every project.
- `bun run check`: PASS.
- The grep lists only comments (`identity-api.module.ts:39`) and the `TokenService` verifier used in `identity-grpc.module.spec.ts`.

`git diff --stat bun.lock` shows only the `apps/gateway` entry.

- [ ] **Step 11: Commit.**

```bash
git add domains/identity/src/identity-core.module.ts domains/identity/src/identity-grpc.module.spec.ts domains/identity/src/application/services/session-tokens.service.ts domains/identity/src/application/services/session-tokens.service.spec.ts domains/identity/src/application/commands/logout/logout.handler.ts domains/identity/src/application/commands/logout/logout.handler.spec.ts domains/identity/src/application/commands/refresh-session/refresh-session.handler.ts domains/identity/src/application/commands/refresh-session/refresh-session.handler.spec.ts domains/identity/test/mocks.ts apps/gateway/test/support/fake-upstreams.ts apps/gateway/test/support/gateway-e2e-app.ts apps/gateway/package.json bun.lock apps/identity-service/src/app.module.ts domains/identity/README.md apps/identity-service/README.md
git commit -F - <<'EOF'
refactor(identity): issue tokens with identity's own TokenIssuer

IdentityCoreModule registers its own JwtModule and the auth + refreshToken
namespaces and provides TokenIssuer; SessionTokensService, LogoutHandler and
RefreshSessionHandler use it instead of the platform TokenService. The
gateway e2e fake identity-service signs with the real TokenIssuer.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task identity-7: `@platform/auth` keeps only verification; the platform `auth` namespace drops the refresh settings

**Files:**
- Test: `libs/auth/src/tokens/token.service.spec.ts` (rewritten: mint with the signer, verify with `TokenService`)
- Modify: `libs/auth/src/tokens/token.service.ts` (full content below; neither D nor F touches this file)
- Modify: `libs/auth/src/auth.module.ts:26-27,50`, `libs/auth/src/types/auth-user.ts:46`, `libs/auth/src/index.ts:1-5`, `libs/auth/package.json:6` (description)
- Modify: `libs/config/src/namespaces/auth.config.ts` (D's file: targeted edits)
- Modify: `libs/config/src/namespaces/namespaces.spec.ts:5-10,141-151,305-334` (targeted edits)
- Modify: `libs/config/src/namespaces/production-guards.spec.ts:5,61-83` (D's file: targeted edits)
- Modify (docs): `libs/auth/README.md`, `docs/SECURITY.md`, `docs/CONFIGURATION.md`, `docs/ARCHITECTURE.md:51`, `libs/config/README.md:23,39`, `.env.example` (auth section)

**Interfaces:**
- Consumes:
  - `signTestAccessToken` (Task identity-1);
  - the refresh guard cases already covered by `domains/identity/src/infrastructure/security/refresh-token.config.spec.ts` (Task identity-5);
  - every issuer caller already switched (identity-2, identity-6).
- Produces:
  - `TokenService` is verification-only: `verifyAccessToken(token: string): Promise<AccessTokenClaims>`, `toAuthUser(claims: AccessTokenClaims): AuthUser` and `get verificationSettings(): JwtVerificationSettings`;
  - `AuthConfig = { accessSecret: string; accessTtlSec: number; issuer: string; audience: string; denylistEnabled: boolean }`;
  - `@platform/config` no longer exports `DEV_JWT_REFRESH_SECRET`; the gateway no longer reads `JWT_REFRESH_*`.

- [ ] **Step 1: Write the failing test.** Replace the whole of `libs/auth/src/tokens/token.service.spec.ts` with:

```ts
import { JwtService } from '@nestjs/jwt';
import { UnauthenticatedException } from '@platform/common';
import { authConfig } from '@platform/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createJwtModuleOptions } from '../auth.module.js';
import { Permission } from '../rbac/permission.enum.js';
import { Role } from '../rbac/role.enum.js';
import { signTestAccessToken } from '../testing/sign-test-access-token.js';
import { TokenService, toUnauthenticated } from './token.service.js';

const config = authConfig.parse({ NODE_ENV: 'test', JWT_ACCESS_TTL_SEC: '900' });
const jwt = new JwtService(createJwtModuleOptions(config));
const tokens = new TokenService(jwt, config);
const user = { id: '0190f3b2-0000-7000-8000-000000000001', email: 'a@b.c', roles: [Role.User] };
const sign = () => signTestAccessToken(user, { config });

async function expectAuthError(promise: Promise<unknown>, code: string): Promise<void> {
  const error: unknown = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(UnauthenticatedException);
  expect((error as UnauthenticatedException).code).toBe(code);
  expect((error as UnauthenticatedException).httpStatus).toBe(401);
}

describe('TokenService', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('verifies only: issuing tokens belongs to the context that owns sessions', () => {
    for (const method of ['issueAccessToken', 'issueRefreshToken', 'verifyRefreshToken']) {
      expect(method in TokenService.prototype, method).toBe(false);
    }
  });

  it('verifies an HS256 access token claim for claim and maps it to the principal', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const issued = await sign();
    const now = Math.floor(Date.now() / 1_000);

    const claims = await tokens.verifyAccessToken(issued.token);
    expect(claims).toEqual({
      sub: user.id,
      email: 'a@b.c',
      roles: [Role.User],
      typ: 'access',
      jti: issued.jti,
      iat: now,
      exp: now + 900,
      iss: 'nestjs-boilerplate',
      aud: 'nestjs-boilerplate',
    });
    expect(tokens.toAuthUser(claims)).toMatchObject({
      id: user.id,
      jti: issued.jti,
      exp: issued.exp,
      permissions: expect.arrayContaining([Permission.BillingCheckout]),
    });
  });

  it('enforces the typ claim even when the signature, iss and aud are right', async () => {
    const forged = await jwt.signAsync(
      { sub: user.id, jti: 's', typ: 'refresh', email: 'a@b.c', roles: [] },
      { secret: config.accessSecret, expiresIn: 60 },
    );
    await expectAuthError(tokens.verifyAccessToken(forged), 'INVALID_TOKEN');
  });

  it('reports expiry distinctly (TOKEN_EXPIRED) and honours the 5s clock tolerance', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const { token } = await sign();
    vi.setSystemTime(Date.now() + (900 + 4) * 1_000);
    await expect(tokens.verifyAccessToken(token)).resolves.toMatchObject({ sub: user.id });
    vi.setSystemTime(Date.now() + 2 * 1_000);
    await expectAuthError(tokens.verifyAccessToken(token), 'TOKEN_EXPIRED');
  });

  it('rejects tampered, foreign-issuer, foreign-audience and empty tokens', async () => {
    const { token } = await sign();
    const [head, body, sig] = token.split('.') as [string, string, string];
    const tampered = `${head}.${Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(body, 'base64url').toString()),
        roles: ['admin'],
      }),
    ).toString('base64url')}.${sig}`;
    await expectAuthError(tokens.verifyAccessToken(tampered), 'INVALID_TOKEN');

    const foreign = await signTestAccessToken(user, {
      config: authConfig.parse({
        NODE_ENV: 'test',
        JWT_ISSUER: 'someone-else',
        JWT_AUDIENCE: 'other-app',
      }),
    });
    await expectAuthError(tokens.verifyAccessToken(foreign.token), 'INVALID_TOKEN');

    const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${body}.`;
    await expectAuthError(tokens.verifyAccessToken(none), 'INVALID_TOKEN');
    await expectAuthError(tokens.verifyAccessToken(''), 'MISSING_TOKEN');
  });

  it('exposes the verification settings shared by every verifier', () => {
    expect(tokens.verificationSettings).toEqual({
      algorithms: ['HS256'],
      issuer: 'nestjs-boilerplate',
      audience: 'nestjs-boilerplate',
      clockTolerance: 5,
    });
  });
});

describe('toUnauthenticated', () => {
  it('maps jsonwebtoken errors by name and keeps our own 401s', () => {
    const expired = Object.assign(new Error('jwt expired'), { name: 'TokenExpiredError' });
    expect(toUnauthenticated(expired).code).toBe('TOKEN_EXPIRED');
    expect(toUnauthenticated(new Error('invalid signature')).code).toBe('INVALID_TOKEN');
    expect(toUnauthenticated('weird').code).toBe('INVALID_TOKEN');
    const own = new UnauthenticatedException('x', { code: 'CUSTOM' });
    expect(toUnauthenticated(own)).toBe(own);
  });
});
```

- [ ] **Step 2: Run it and see it fail.**

```bash
npx vitest run --project auth token.service
```
Expected: FAIL in `verifies only: …` with `issueAccessToken: expected true to be false`. Every other case passes.

- [ ] **Step 3: Make `TokenService` verification-only.** Replace the whole of `libs/auth/src/tokens/token.service.ts` with:

```ts
import { Inject, Injectable } from '@nestjs/common';
import { JwtService, type JwtVerifyOptions } from '@nestjs/jwt';
import { UnauthenticatedException } from '@platform/common';
import { type AuthConfig, authConfig } from '@platform/config';
import { AuthErrorCode, JWT_ALGORITHM, JWT_CLOCK_TOLERANCE_SEC } from '../auth.constants.js';
import type { AccessTokenClaims, AuthUser } from '../types/auth-user.js';
import { parseAccessTokenClaims, toAuthUser } from './token-claims.js';

/** Verification settings every verifier (TokenService, JwtStrategy, WS handshake) must share. */
export interface JwtVerificationSettings {
  algorithms: NonNullable<JwtVerifyOptions['algorithms']>;
  issuer: string;
  audience: string;
  /** Seconds. */
  clockTolerance: number;
}

/**
 * Maps jsonwebtoken failures to 401s with a stable code. Matched by `name` because
 * jsonwebtoken's error classes are not a dependency of this package.
 */
export function toUnauthenticated(error: unknown): UnauthenticatedException {
  if (error instanceof UnauthenticatedException) return error;
  const name = error instanceof Error ? error.name : '';
  if (name === 'TokenExpiredError') {
    return new UnauthenticatedException('Token has expired', {
      code: AuthErrorCode.TOKEN_EXPIRED,
      cause: error,
    });
  }
  return new UnauthenticatedException('Invalid token', {
    code: AuthErrorCode.INVALID_TOKEN,
    cause: error,
  });
}

/**
 * Verifies access tokens locally, with no RPC per request: HS256 signature, `iss`/`aud`, `exp`
 * (5 s tolerance), then the `typ` claim. This package does not issue tokens: the bounded context
 * that owns sessions signs them with the shared `JWT_ACCESS_SECRET`, and tests sign them with
 * `signTestAccessToken` (`@platform/auth/testing`).
 */
@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    @Inject(authConfig.KEY) private readonly config: AuthConfig,
  ) {}

  /** Throws `UnauthenticatedException` (`TOKEN_EXPIRED` / `INVALID_TOKEN`). Denylist NOT checked. */
  async verifyAccessToken(token: string): Promise<AccessTokenClaims> {
    return parseAccessTokenClaims(await this.verify(token));
  }

  toAuthUser(claims: AccessTokenClaims): AuthUser {
    return toAuthUser(claims);
  }

  /** What verifiers must enforce to accept exactly the tokens signed for this deployment. */
  get verificationSettings(): JwtVerificationSettings {
    return {
      algorithms: [JWT_ALGORITHM],
      issuer: this.config.issuer,
      audience: this.config.audience,
      clockTolerance: JWT_CLOCK_TOLERANCE_SEC,
    };
  }

  private async verify(token: string): Promise<unknown> {
    if (token.length === 0) {
      throw new UnauthenticatedException('Missing token', { code: AuthErrorCode.MISSING_TOKEN });
    }
    try {
      return await this.jwt.verifyAsync<Record<string, unknown>>(token, {
        secret: this.config.accessSecret,
        ...this.verificationSettings,
      });
    } catch (error) {
      throw toUnauthenticated(error);
    }
  }
}
```

- [ ] **Step 4: Run it.**

```bash
npx vitest run --project auth
```
Expected: PASS (all specs; `token.service` now has 7 cases).

- [ ] **Step 5: Fix the platform docstrings and the description.**
- `libs/auth/src/auth.module.ts`: replace:
```ts
 * `TokenService` writes `exp` into the payload and jsonwebtoken rejects both at once.
```
with:
```ts
 * token issuers write `exp` into the payload and jsonwebtoken rejects both at once.
```
and replace:
```ts
 * Global authentication & authorization (blueprint §3.11): JWT issuing/verification, the Redis
```
with:
```ts
 * Global authentication & authorization (blueprint §3.11): access-token verification, the Redis
```
- `libs/auth/src/types/auth-user.ts`: replace ``/** What `TokenService.issueAccessToken` needs to know about the user. */`` with ``/** What an access-token issuer (and `signTestAccessToken`) needs to know about the user. */``.
- `libs/auth/src/index.ts`: replace:
```ts
 * @platform/auth — JWT authentication (passport-jwt, HS256, verified locally at every service),
 * refresh tokens, the Redis access-token denylist and RBAC
 * (roles → permissions, guards, decorators) for HTTP, GraphQL and WebSocket handlers.
```
with:
```ts
 * @platform/auth — JWT access-token verification (passport-jwt, HS256, verified locally at every
 * service), the Redis access-token denylist and RBAC (roles → permissions, guards, decorators) for
 * HTTP, GraphQL and WebSocket handlers. Tokens are issued by the context that owns sessions; tests
 * sign them with `@platform/auth/testing`.
```
- `libs/auth/package.json` description: replace `JWT authentication (passport-jwt, HS256, local verification), refresh tokens, Redis access-token denylist and RBAC guards/decorators for HTTP, GraphQL and WebSocket.` with `JWT access-token verification (passport-jwt, HS256, local), Redis access-token denylist, RBAC guards/decorators for HTTP, GraphQL and WebSocket, and a test-token signer (./testing).`

- [ ] **Step 6: Shrink the platform `auth` namespace.** These are D's files: make targeted edits only, and apply the same intent if D's wording differs.

In `libs/config/src/namespaces/auth.config.ts`, replace:
```ts
/** Development-only defaults so `bun run dev` works with zero `.env`. Rejected in production. */
export const DEV_JWT_ACCESS_SECRET = 'dev-access-secret-change-me-please-32chars';
export const DEV_JWT_REFRESH_SECRET = 'dev-refresh-secret-change-me-please-32chars';
```
with:
```ts
/** Development-only default so `bun run dev` works with zero `.env`. Rejected in production. */
export const DEV_JWT_ACCESS_SECRET = 'dev-access-secret-change-me-please-32chars';
```
Delete:
```ts
    JWT_REFRESH_SECRET: zStr(DEV_JWT_REFRESH_SECRET, { min: MIN_JWT_SECRET_LENGTH }),
    JWT_REFRESH_TTL_SEC: zInt(604_800, { min: 1 }),
```
Delete `      JWT_REFRESH_SECRET: DEV_JWT_REFRESH_SECRET,` from the `devDefaults` object. Replace:
```ts
    // A shared secret would let a refresh token verify as an access token (and vice versa).
    if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['JWT_REFRESH_SECRET'],
        message: 'JWT_REFRESH_SECRET must differ from JWT_ACCESS_SECRET in production',
      });
    }
```
with:
```ts
    // The refresh secret (dev default, known values, must differ from this one) is guarded by the
    // issuer's own `refreshToken` namespace.
```
Delete:
```ts
    refreshSecret: env.JWT_REFRESH_SECRET,
    refreshTtlSec: env.JWT_REFRESH_TTL_SEC,
```
Replace `/** JWT signing/verification, token TTLs, access-token denylist. */` with ``/** Access tokens: secret and TTL (signer side), `iss`/`aud` and the denylist (every verifier). */``.

In `libs/config/src/namespaces/namespaces.spec.ts`, replace:
```ts
import {
  type AuthConfig,
  authConfig,
  DEV_JWT_ACCESS_SECRET,
  DEV_JWT_REFRESH_SECRET,
} from './auth.config.js';
```
with:
```ts
import { type AuthConfig, authConfig, DEV_JWT_ACCESS_SECRET } from './auth.config.js';
```
Delete these two lines from the `authConfig.parse({})` expectation:
```ts
      refreshSecret: DEV_JWT_REFRESH_SECRET,
      refreshTtlSec: 604_800,
```
Replace the whole `describe('auth production secret guard', …)` block with:
```ts
describe('auth production secret guard', () => {
  it('rejects the development default access secret in production', () => {
    const error = errorOf(() => authConfig.parse({ NODE_ENV: 'production' }));
    expect(error.message).toContain('→ at JWT_ACCESS_SECRET');
    expect(error.message).not.toContain(DEV_JWT_ACCESS_SECRET);
  });

  it('accepts a strong access secret in production and the dev default elsewhere', () => {
    expect(
      authConfig.parse({ NODE_ENV: 'production', JWT_ACCESS_SECRET: 'a'.repeat(48) }).accessSecret,
    ).toBe('a'.repeat(48));
    expect(authConfig.parse({ NODE_ENV: 'test' }).accessSecret).toBe(DEV_JWT_ACCESS_SECRET);
  });
});
```
The refresh-secret cases (dev default, must differ, strong distinct secrets) live in `domains/identity/src/infrastructure/security/refresh-token.config.spec.ts`.

In D's `libs/config/src/namespaces/production-guards.spec.ts`, replace `import { authConfig, DEV_JWT_ACCESS_SECRET, DEV_JWT_REFRESH_SECRET } from './auth.config.js';` with `import { authConfig, DEV_JWT_ACCESS_SECRET } from './auth.config.js';`. In `describe('auth: known local secrets', …)`, delete these three lines (their equivalents are in `refresh-token.config.spec.ts`):
```ts
      JWT_REFRESH_SECRET: COMPOSE.JWT_REFRESH_SECRET,
```
```ts
    expect(error.message).toContain('→ at JWT_REFRESH_SECRET');
```
```ts
    expect(DEV_JWT_REFRESH_SECRET).toContain('change-me');
```
The rule, whatever D's final wording is: no assertion about `JWT_REFRESH_SECRET` or `DEV_JWT_REFRESH_SECRET` remains in `libs/config`.

Then run:
```bash
npx vitest run --project config
```
Expected: PASS.

- [ ] **Step 7: Update the docs.**
- **`libs/auth/README.md`:**
  - Replace the bullet `- refresh tokens are signed with their own secret` with two bullets:
    ```
    - tokens are issued by the identity context (`TokenIssuer`); this package only verifies them
    - `@platform/auth/testing` signs access tokens for tests
    ```
  - In the `TokenService` row, replace the Purpose cell with `` `verifyAccessToken(token)` → claims (signature, `iss`/`aud`, `exp` ± 5 s, `typ`; denylist not checked); `toAuthUser(claims)`; `verificationSettings`. Verification only. ``
  - In the helpers row (`parseAccessTokenClaims`, `parseRefreshTokenClaims`, …), replace `Claim validation and error mapping.` with `` Claim validation and error mapping. The refresh-claim parser is shared with the issuer, so the `typ` cross-check lives in one place. ``
  - Replace `// gRPC-only service: no global guards, just issue/verify tokens and the denylist` with `// gRPC-only service: no global guards, just verification and the denylist`.
  - Delete the bullets `` - `JWT_REFRESH_SECRET`: must differ from the access secret in production. `` and `` - `JWT_REFRESH_TTL_SEC`: default 604800. ``.
  - Directly after the variable list, add the paragraph `` `JWT_REFRESH_SECRET`/`JWT_REFRESH_TTL_SEC` belong to the identity context's `refreshToken` namespace: verifying processes such as the gateway never load them. ``
  - In the **Token types** gotcha, replace `` `TokenService` writes `iat` and `exp` into the payload `` with `` Issuers (and `signTestAccessToken`) write `iat` and `exp` into the payload ``.
- **`docs/SECURITY.md`:**
  - Replace `(tokens, guards) and` with `(access-token verification, guards, denylist) and`.
  - Replace `(password hashing, sessions, rotation, logout).` with `(token issuance, password hashing, sessions, rotation, logout).`
  - After the bullet that starts ``- `iss`/`aud` default to `nestjs-boilerplate` ``, add ``- Identity signs both tokens (`TokenIssuer`, `domains/identity/src/infrastructure/security/`). The refresh secret and TTL live in identity's `refreshToken` namespace, which only the processes running `IdentityCoreModule` (monolith, identity-service) load: the gateway holds the access secret only.``
  - In the boot-time guard table:
    - In the row whose Guard cell is:
      ```markdown
      `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` must not be the dev defaults and must differ
      ```
      replace the Source cell with:
      ```markdown
      `libs/config/src/namespaces/auth.config.ts`, `domains/identity/src/infrastructure/security/refresh-token.config.ts`
      ```
    - In the publicly-known-values row, replace `` `auth`, `stripe`, `storage` namespaces `` with `` `auth`, `refreshToken`, `stripe`, `storage` namespaces ``.
    - In the row `JWT secrets ≥ 32 characters (all environments)`, replace `` `auth.config.ts` `` with `` `auth.config.ts`, `refresh-token.config.ts` ``.
  - In the production checklist, replace `and identity-service share the access secret.` with `and identity-service share the access secret; only identity-service (or the monolith) needs the refresh secret.`
- **`docs/CONFIGURATION.md`:**
  - In "## Which app loads which namespace", insert this row after the `` `password` `` row:
    ```
    | `refreshToken` | ✓ | | ✓ | | | `IdentityCoreModule` (`@domain/identity`) |
    ```
    In the `` `auth` `` row of the same table, replace the "Loaded by" cell `` `AuthModule` `` with `` `AuthModule`, `IdentityCoreModule` (`TokenIssuer`) ``.
  - Replace the heading ``### `auth` — JWT`` with ``### `auth` — access tokens (JWT)``.
  - Delete the `` `JWT_REFRESH_SECRET` `` and `` `JWT_REFRESH_TTL_SEC` `` rows of the `auth` table.
  - In the `` `ALLOW_KNOWN_LOCAL_SECRETS` `` row, replace ``Read by the `auth`, `stripe` and `storage` namespaces.`` with ``Read by the `auth`, `stripe` and `storage` namespaces and identity's `refreshToken` namespace.``
  - Insert this directly before the heading ``### `password` — Argon2id (identity)``:
````markdown
### `refreshToken` — refresh tokens (identity)

[`refresh-token.config.ts`](../domains/identity/src/infrastructure/security/refresh-token.config.ts) ·
monolith, identity-service (loaded by `IdentityCoreModule`; the gateway never reads it)

| Variable              | Default                                       | Description                                                                                                                                                                                                                  |
| --------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JWT_REFRESH_SECRET`  | `dev-refresh-secret-change-me-please-32chars` | ≥ 32 chars. **Dev default rejected in production**, publicly known values too (unless `ALLOW_KNOWN_LOCAL_SECRETS=true`), and it must differ from `JWT_ACCESS_SECRET` there (this namespace reads it for that check only). |
| `JWT_REFRESH_TTL_SEC` | `604800`                                      | Refresh token lifetime (7 days).                                                                                                                                                                                             |

````
  - In "## Production guards" (the table with a Source column):
    - In the row `JWT secrets must not be the development defaults`, replace the source `` `auth.config.ts` `` with `` `auth.config.ts`, `refresh-token.config.ts` ``.
    - In the row `Access and refresh secrets must differ …`, replace the source `` `auth.config.ts` `` with `` `refresh-token.config.ts` ``.
    - In the `Publicly known values …` row, replace the source `` `auth`, `stripe`, `storage` `` with `` `auth`, `refreshToken`, `stripe`, `storage` ``.
- **`docs/ARCHITECTURE.md`:** in the `libs/auth` row, replace ``JWT + RBAC guards, `TokenService`, access-token denylist`` with ``JWT verification + RBAC guards, `TokenService` (verification only), access-token denylist, `@platform/auth/testing` ``.
- **`libs/config/README.md`:**
  - In the `auth` row, replace `` `JWT_ACCESS_SECRET`/`JWT_REFRESH_SECRET` (≥ 32 chars, dev defaults), `JWT_ACCESS_TTL_SEC` (900), `JWT_REFRESH_TTL_SEC` (604800), `` with `` `JWT_ACCESS_SECRET` (≥ 32 chars, dev default), `JWT_ACCESS_TTL_SEC` (900), ``.
  - In the Constants row, delete `` `DEV_JWT_REFRESH_SECRET`, ``.
- **`.env.example`:** replace every line from the one that starts `# ── auth:` up to, but not including, the one that starts `# ── throttle:` with the block below. If D or F added lines inside that range, keep each one next to the variable it documents.
```
# ── auth: access tokens, verified at every edge (gateway, monolith, identity-service) ────────
# >= 32 chars. The defaults below are DEV ONLY and rejected when NODE_ENV=production;
# generate real ones with: node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
# JWT_ACCESS_SECRET=dev-access-secret-change-me-please-32chars
# JWT_ACCESS_TTL_SEC=900
# JWT_ISSUER=nestjs-boilerplate
# JWT_AUDIENCE=nestjs-boilerplate
# Redis denylist of logged-out access tokens (jti)
# AUTH_DENYLIST_ENABLED=true
# LOCAL compose stack only: accept the publicly known compose fallbacks (JWT, Stripe, RustFS keys)
# in production mode. The development defaults are always rejected in production.
# ALLOW_KNOWN_LOCAL_SECRETS=false

# ── identity: refreshToken + password namespaces (monolith, identity-service) ─────────────────
# Refresh-token secret: >= 32 chars, DEV ONLY default (rejected when NODE_ENV=production), and it
# must differ from JWT_ACCESS_SECRET there
# JWT_REFRESH_SECRET=dev-refresh-secret-change-me-please-32chars
# JWT_REFRESH_TTL_SEC=604800
# Argon2id cost (OWASP baseline m=19 MiB, t=2, p=1); hashing runs on the libuv pool (UV_THREADPOOL_SIZE)
# ARGON2_MEMORY_COST=19456
# ARGON2_TIME_COST=2
# ARGON2_PARALLELISM=1

```

Then run:
```bash
bunx prettier --write libs/auth/README.md docs/SECURITY.md docs/CONFIGURATION.md docs/ARCHITECTURE.md libs/config/README.md
```

- [ ] **Step 8: Run the full verification.**

```bash
bunx biome check --write libs/auth libs/config/src
git grep -n -E "issueAccessToken|issueRefreshToken|verifyRefreshToken" -- libs
git grep -n "DEV_JWT_REFRESH_SECRET\|refreshTtlSec\|refreshSecret" -- libs
node scripts/check-env-example.mjs
bun run check
bun run test
bun run build
```
Expected:
- The first grep lists only `libs/auth/src/tokens/token.service.spec.ts` (the `verifies only` case).
- The second grep prints nothing.
- `check-env-example`: PASS. This needs lane platform's domain scan; otherwise it prints `.env.example lists JWT_REFRESH_SECRET, which @platform/config does not read`.
- `bun run check`: PASS.
- `bun run test`: PASS. This covers every unit project plus `gateway:e2e`, `monolith:e2e`, `identity-service:e2e`, `notifications-service:e2e` and `billing-service:e2e`.
- `bun run build`: PASS.

- [ ] **Step 9: Commit.**

```bash
git add libs/auth/src/tokens/token.service.ts libs/auth/src/tokens/token.service.spec.ts libs/auth/src/auth.module.ts libs/auth/src/types/auth-user.ts libs/auth/src/index.ts libs/auth/package.json libs/config/src/namespaces/auth.config.ts libs/config/src/namespaces/namespaces.spec.ts libs/config/src/namespaces/production-guards.spec.ts libs/auth/README.md docs/SECURITY.md docs/CONFIGURATION.md docs/ARCHITECTURE.md libs/config/README.md .env.example
git commit -F - <<'EOF'
refactor(auth): keep access-token verification only

TokenService no longer issues tokens or verifies refresh tokens; identity's
TokenIssuer does. The platform `auth` namespace drops JWT_REFRESH_SECRET and
JWT_REFRESH_TTL_SEC (identity's `refreshToken` namespace owns them, with the
dev-default, known-value and must-differ production guards), so verifying
edges such as the gateway no longer read the refresh secret.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```
