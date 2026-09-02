import { CognitoJwtVerifier } from 'aws-jwt-verify';

/**
 * Token verification for the chat endpoint.
 *
 * This matters more here than anywhere else in the stack, so it is worth stating
 * plainly: the chat is served from a Lambda Function URL, and **API Gateway's Cognito
 * authorizer is not in front of it**. Every other route in this app is authenticated by
 * the gateway before the handler runs. This one is not. Its only gate is this file.
 *
 * So the handler verifies the ID token itself — signature against the pool's JWKS, `iss`
 * against the pool, `aud` against the app client, `token_use` = id, and expiry — and
 * rejects anything that fails with 401 before it reads a record or calls Bedrock.
 * Ownership is then checked per record on top of that, so a valid token for one account
 * still cannot reach another account's artifact.
 */

const USER_POOL_ID = process.env.USER_POOL_ID || '';
const USER_POOL_CLIENT_ID = process.env.USER_POOL_CLIENT_ID || '';

/**
 * `tokenUse: 'id'` is not incidental.
 *
 * The browser sends the ID token because that is what API Gateway's authorizer wants
 * elsewhere in this app, and accepting either token type would mean an access token
 * scoped for a different purpose would also open this endpoint.
 */
const verifier = USER_POOL_ID && USER_POOL_CLIENT_ID
  ? CognitoJwtVerifier.create({
    userPoolId: USER_POOL_ID,
    tokenUse: 'id',
    clientId: USER_POOL_CLIENT_ID,
  })
  : null;

/**
 * Fetch the JWKS at container start rather than on the first request.
 *
 * Without this the first verification of every cold container pays an HTTPS round trip
 * to Cognito before the model is even called, which lands squarely on the metric this
 * feature is judged by. Failures are swallowed deliberately: hydration is an
 * optimisation, and `verify` fetches the key set itself if this did not finish.
 */
const hydrated: Promise<void> = verifier
  ? verifier.hydrate().then(() => undefined, () => undefined)
  : Promise.resolve();

export interface VerifiedCaller {
  userId: string;
  email?: string;
}

/**
 * Extract the bearer token from the request headers.
 *
 * Both `Authorization: <jwt>` and `Authorization: Bearer <jwt>` are accepted, because
 * the app's own `authFetch` sends the bare token while every HTTP client and proxy in
 * the world assumes the Bearer prefix. Function URL header names arrive lowercased, but
 * the capitalised form is checked too so a direct invoke in a test behaves the same.
 */
export function bearerToken(headers: Record<string, string | undefined> | undefined): string | null {
  const raw = headers?.authorization || headers?.Authorization;
  if (!raw) return null;
  const value = raw.trim();
  if (!value) return null;
  const match = value.match(/^Bearer\s+(.+)$/i);
  return (match ? match[1] : value).trim() || null;
}

/**
 * Verify a request's token, or return null.
 *
 * Null for every failure — missing, malformed, expired, wrong audience, wrong pool. The
 * caller turns that into a single 401 with no detail, because telling an unauthenticated
 * caller *why* their token was refused is free reconnaissance.
 */
export async function verifyCaller(
  headers: Record<string, string | undefined> | undefined,
): Promise<VerifiedCaller | null> {
  if (!verifier) {
    console.error('[chat] USER_POOL_ID or USER_POOL_CLIENT_ID is not set; refusing every request');
    return null;
  }

  const token = bearerToken(headers);
  if (!token) return null;

  await hydrated;
  try {
    const payload = await verifier.verify(token);
    const userId = typeof payload.sub === 'string' ? payload.sub : '';
    if (!userId) return null;
    const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : undefined;
    return { userId, email };
  } catch (error) {
    console.warn('[chat] token rejected:', (error as Error).message);
    return null;
  }
}
