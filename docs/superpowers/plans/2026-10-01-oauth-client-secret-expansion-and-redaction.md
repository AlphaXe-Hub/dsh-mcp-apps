# OAuth Client Secret Expansion & Redaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `${VAR}` environment variable expansion for `oauth.clientSecret` in remote MCP server configuration and ensure the expanded secret is included in redaction candidates to prevent secret leakage in error logs.

**Architecture:** Remote servers with static OAuth client configuration accept `oauth.clientSecret`. In `ServerPool`, when instantiating `RemoteOAuthProvider`, `options.clientSecret` will be expanded using `expandEnvVars()` against `process.env` governed by `serverConfig.allowedVars`. In error sanitization, both `secretValuesFor()` and `oauthSecretCandidates()` will include the expanded `clientSecret` so that `sanitizeErrorMessage()` redacts the secret, url-encoded variants, and token forms before errors are logged or returned to clients.

**Tech Stack:** TypeScript, Node.js 22, Vitest, `@modelcontextprotocol/sdk`.

**Spec:** [docs/oauth-remote-auth-design.md](file:///Users/keita/Developer/work/dsh-mcp-apps/docs/oauth-remote-auth-design.md) (Configuration Contract: Static client credentials adhere to the same environment variable expansion and secret redaction rules as headers and environment variables).

## Global Constraints

- Never pass unexpanded `${VAR}` expressions to the OAuth Identity Provider.
- Follow the allowlist security policy: variables matching sensitive patterns (`*SECRET*`, `*KEY*`, `*TOKEN*`, `*PASSWORD*`, `DSH_*`, `SSH_AUTH_SOCK`, `GPG_AGENT_INFO`) must be in `serverConfig.allowedVars` to expand.
- Never leak secrets in error messages, connection failures, or `servers/status` RPC responses.
- Maintain backwards compatibility: `oauth: true` (dynamic client registration) must remain unaffected.
- Keep tests completely hermetic using temporary test environments.

## Review Focus

1. **Unlisted sensitive environment variable**: When `clientSecret: '${MY_CLIENT_SECRET}'` is configured but `allowedVars` does not permit `MY_CLIENT_SECRET`, it should safely expand to empty string (or `:-default`), never reading the sensitive variable.
2. **Special characters in secret**: Secrets containing regex special characters or URL encoding must be cleanly redacted by `sanitizeErrorMessage` without regex syntax crashes.
3. **Short secrets under 3 characters**: As documented in the sanitization contract, secrets under 3 characters must not cause collateral over-redaction of common substrings.
4. **Missing or undefined `clientSecret`**: Servers using dynamic client registration (`oauth: true`) or static clients without secrets (`clientSecret` undefined) must not throw or alter provider behavior.
5. **Dynamic reload / provider reuse**: `getOrCreateOAuthProvider` caches the provider per server; the expanded secret must remain stable across calls.

---

### Task 1: Environment Variable Expansion for `oauth.clientSecret`

**Files:**
- Modify: `src/transports/server-pool.ts:627-635`
- Test: `tests/oauth-server-pool.spec.ts`

**Interfaces:**
- Consumes: `expandEnvVars(dict, env, allowedVars)` from `src/config.ts`
- Modifies: `ServerPool.getOrCreateOAuthProvider(serverName: string, options: true | OAuthOptions): RemoteOAuthProvider`
- Produces: `RemoteOAuthProvider` initialized with expanded `clientSecret`

- [ ] **Step 1: Write failing unit test for `clientSecret` environment variable expansion**

Add tests to `tests/oauth-server-pool.spec.ts`:
```typescript
describe('ServerPool OAuth clientSecret expansion', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv, TEST_CLIENT_SECRET: 'super-secret-pass-123' }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('expands allowed environment variables in oauth.clientSecret', async () => {
    const pool = new ServerPool({} as any, {
      servers: {
        oauth_server: {
          transport: 'streamable-http',
          url: 'https://mcp.example.com',
          oauth: {
            clientId: 'static-client-id',
            clientSecret: '${TEST_CLIENT_SECRET}',
          },
          allowedVars: ['TEST_CLIENT_SECRET'],
        },
      },
    }, toolManagerStub)

    const provider = (pool as any).getOrCreateOAuthProvider('oauth_server', {
      clientId: 'static-client-id',
      clientSecret: '${TEST_CLIENT_SECRET}',
    })

    const clientInfo = await provider.clientInformation()
    expect(clientInfo?.client_secret).toBe('super-secret-pass-123')
  })

  it('blocks unallowed sensitive environment variables in oauth.clientSecret', async () => {
    const pool = new ServerPool({} as any, {
      servers: {
        oauth_server: {
          transport: 'streamable-http',
          url: 'https://mcp.example.com',
          oauth: {
            clientId: 'static-client-id',
            clientSecret: '${TEST_CLIENT_SECRET:-fallback-secret}',
          },
          // TEST_CLIENT_SECRET is NOT in allowedVars
        },
      },
    }, toolManagerStub)

    const provider = (pool as any).getOrCreateOAuthProvider('oauth_server', {
      clientId: 'static-client-id',
      clientSecret: '${TEST_CLIENT_SECRET:-fallback-secret}',
    })

    const clientInfo = await provider.clientInformation()
    expect(clientInfo?.client_secret).toBe('fallback-secret')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/oauth-server-pool.spec.ts`
Expected: FAIL (`expected 'super-secret-pass-123', received '${TEST_CLIENT_SECRET}'`)

- [ ] **Step 3: Implement minimal code for `clientSecret` expansion in `getOrCreateOAuthProvider`**

In `src/transports/server-pool.ts`:
```typescript
  private getOrCreateOAuthProvider(serverName: string, options: true | OAuthOptions): RemoteOAuthProvider {
    let provider = this.oauthProviders.get(serverName)
    if (!provider) {
      let resolvedOptions = options
      if (options !== true && options.clientSecret) {
        const serverConfig = this.config.servers[serverName]
        const allowed = new Set(serverConfig?.allowedVars)
        const expandedSecret = expandEnvVars({ secret: options.clientSecret }, process.env, allowed).secret
        resolvedOptions = { ...options, clientSecret: expandedSecret }
      }
      provider = new RemoteOAuthProvider(serverName, resolvedOptions, this.config.externalUrl ?? '', this.oauthTokenStore)
      this.oauthProviders.set(serverName, provider)
    }
    return provider
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/oauth-server-pool.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/transports/server-pool.ts tests/oauth-server-pool.spec.ts
git commit -m "feat(oauth): expand environment variables in oauth.clientSecret"
```

---

### Task 2: Redaction of `oauth.clientSecret` in Error Sanitization

**Files:**
- Modify: `src/transports/server-pool.ts:160-163, 636-641`
- Test: `tests/server-pool.spec.ts`

**Interfaces:**
- Modifies: `secretValuesFor(serverConfig: ServerConfig, extra?: string[]): string[]`
- Modifies: `ServerPool.oauthSecretCandidates(serverName: string): string[]`
- Produces: Redaction candidate list including expanded `clientSecret`

- [ ] **Step 1: Write failing unit test for `clientSecret` error redaction**

In `tests/server-pool.spec.ts`:
```typescript
describe('secretValuesFor with OAuth clientSecret', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv, OAUTH_SECRET: 'my-confidential-secret-999' }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('includes expanded oauth.clientSecret in secret redaction values', () => {
    const config: ServerConfig = {
      transport: 'streamable-http',
      url: 'https://mcp.example.com',
      headers: { Authorization: 'Bearer token-123' },
      oauth: {
        clientId: 'client',
        clientSecret: '${OAUTH_SECRET}',
      },
      allowedVars: ['OAUTH_SECRET'],
    }

    const pool = new ServerPool({} as any, {
      servers: { test_server: config },
    }, toolManagerStub)

    const error = new Error('Failed to connect with secret my-confidential-secret-999 at https://mcp.example.com')
    const sanitized = pool.sanitizeError('test_server', error)

    expect(sanitized).not.toContain('my-confidential-secret-999')
    expect(sanitized).toContain('[redacted]')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/server-pool.spec.ts`
Expected: FAIL (`expected message not to contain 'my-confidential-secret-999'`)

- [ ] **Step 3: Implement minimal code for `clientSecret` redaction**

In `src/transports/server-pool.ts`:
1. Update `secretValuesFor`:
```typescript
function secretValuesFor(serverConfig: ServerConfig, extra: string[] = []): string[] {
  const dict = serverConfig.transport === 'stdio' ? serverConfig.env : serverConfig.headers
  const values = Object.values(expandEnvVars(dict, process.env, new Set(serverConfig.allowedVars)))
  if (serverConfig.transport !== 'stdio' && serverConfig.oauth && serverConfig.oauth !== true && serverConfig.oauth.clientSecret) {
    const expandedSecret = expandEnvVars({ secret: serverConfig.oauth.clientSecret }, process.env, new Set(serverConfig.allowedVars)).secret
    if (expandedSecret) values.push(expandedSecret)
  }
  return [...values, ...extra]
}
```

2. Update `oauthSecretCandidates`:
```typescript
  /** Extra redaction candidates for {@link sanitizeErrorMessage}: this server's current access/refresh token, if any, plus configured OAuth client secret. */
  private oauthSecretCandidates(serverName: string): string[] {
    const candidates: string[] = []
    const tokens = this.oauthTokenStore.getTokens(serverName)
    if (tokens) {
      if (typeof tokens.accessToken === 'string') candidates.push(tokens.accessToken)
      if (typeof tokens.refreshToken === 'string') candidates.push(tokens.refreshToken)
    }
    const serverConfig = this.config.servers[serverName]
    if (serverConfig && serverConfig.transport !== 'stdio' && serverConfig.oauth && serverConfig.oauth !== true && serverConfig.oauth.clientSecret) {
      const expandedSecret = expandEnvVars({ secret: serverConfig.oauth.clientSecret }, process.env, new Set(serverConfig.allowedVars)).secret
      if (expandedSecret) candidates.push(expandedSecret)
    }
    return candidates
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/server-pool.spec.ts`
Expected: PASS

- [ ] **Step 5: Run full test suite to ensure no regressions**

Run: `pnpm test`
Expected: All test suites PASS

- [ ] **Step 6: Commit**

```bash
git add src/transports/server-pool.ts tests/server-pool.spec.ts
git commit -m "fix(security): redact oauth.clientSecret in error sanitization"
```
