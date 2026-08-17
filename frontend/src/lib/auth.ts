import {
  CognitoUserPool,
  CognitoUser,
  AuthenticationDetails,
  CognitoUserSession,
  CognitoUserAttribute,
  ISignUpResult,
} from 'amazon-cognito-identity-js';

const USER_POOL_ID = process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID!;
const CLIENT_ID = process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID!;

// Cookie name shared with middleware
export const AUTH_COOKIE_NAME = 'iep_auth_session';

let _pool: CognitoUserPool | null = null;
let _pendingNewPasswordUser: CognitoUser | null = null;

function getPool(): CognitoUserPool {
  if (!_pool) {
    if (typeof window !== 'undefined') {
      try {
        const keysToRemove: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && key.startsWith('CognitoIdentityServiceProvider.') && !key.includes(CLIENT_ID)) {
            keysToRemove.push(key);
          }
        }
        keysToRemove.forEach((k) => localStorage.removeItem(k));
      } catch (e) {
        // ignore
      }
    }
    _pool = new CognitoUserPool({
      UserPoolId: USER_POOL_ID,
      ClientId: CLIENT_ID,
    });
  }
  return _pool;
}

/** Sets a 1-hour cookie readable by Next.js middleware (not httpOnly). */
function setSessionCookie(token: string): void {
  document.cookie = `${AUTH_COOKIE_NAME}=${token}; path=/; max-age=3600; SameSite=Strict`;
}

/** Clears the session cookie on sign-out. */
function clearSessionCookie(): void {
  document.cookie = `${AUTH_COOKIE_NAME}=; path=/; max-age=0; SameSite=Strict`;
}

// ---------------------------------------------------------------------------
// Sign In
// ---------------------------------------------------------------------------
export function signIn(email: string, password: string): Promise<CognitoUserSession> {
  return new Promise((resolve, reject) => {
    const pool = getPool();
    const user = new CognitoUser({ Username: email.toLowerCase(), Pool: pool });
    const authDetails = new AuthenticationDetails({
      Username: email.toLowerCase(),
      Password: password,
    });

    user.authenticateUser(authDetails, {
      onSuccess(session) {
        setSessionCookie(session.getAccessToken().getJwtToken());
        resolve(session);
      },
      newPasswordRequired() {
        _pendingNewPasswordUser = user;
        reject(Object.assign(new Error('NEW_PASSWORD_REQUIRED'), { code: 'NEW_PASSWORD_REQUIRED' }));
      },
      onFailure: reject,
    });
  });
}

// ---------------------------------------------------------------------------
// Sign Up
// ---------------------------------------------------------------------------
export function signUp(email: string, password: string): Promise<ISignUpResult> {
  return new Promise((resolve, reject) => {
    const pool = getPool();
    const attributes = [
      new CognitoUserAttribute({ Name: 'email', Value: email.toLowerCase() }),
    ];
    pool.signUp(email.toLowerCase(), password, attributes, [], (err, result) => {
      if (err) return reject(err);
      resolve(result!);
    });
  });
}

// ---------------------------------------------------------------------------
// Confirm Sign Up (email verification code)
// ---------------------------------------------------------------------------
export function confirmSignUp(email: string, code: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const pool = getPool();
    const user = new CognitoUser({ Username: email.toLowerCase(), Pool: pool });
    user.confirmRegistration(code, true, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// Resend verification code
// ---------------------------------------------------------------------------
export function resendCode(email: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const pool = getPool();
    const user = new CognitoUser({ Username: email.toLowerCase(), Pool: pool });
    user.resendConfirmationCode((err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// Forgot Password
// ---------------------------------------------------------------------------
export function forgotPassword(email: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const pool = getPool();
    const user = new CognitoUser({ Username: email.toLowerCase(), Pool: pool });
    user.forgotPassword({
      onSuccess() {
        resolve();
      },
      onFailure(err) {
        reject(err);
      },
    });
  });
}

export function confirmForgotPassword(email: string, code: string, newPassword: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const pool = getPool();
    const user = new CognitoUser({ Username: email.toLowerCase(), Pool: pool });
    user.confirmPassword(code, newPassword, {
      onSuccess() {
        resolve();
      },
      onFailure(err) {
        reject(err);
      },
    });
  });
}

// ---------------------------------------------------------------------------
// Complete new password challenge (first sign-in after account migration / reset)
// ---------------------------------------------------------------------------
export function completeNewPasswordChallenge(newPassword: string): Promise<CognitoUserSession> {
  return new Promise((resolve, reject) => {
    if (!_pendingNewPasswordUser) {
      reject(Object.assign(new Error('No pending new-password challenge. Please sign in again.'), {
        code: 'NO_PENDING_NEW_PASSWORD_CHALLENGE',
      }));
      return;
    }

    const user = _pendingNewPasswordUser;
    user.completeNewPasswordChallenge(newPassword, {}, {
      onSuccess(session) {
        _pendingNewPasswordUser = null;
        setSessionCookie(session.getAccessToken().getJwtToken());
        resolve(session);
      },
      onFailure(err) {
        reject(err);
      },
    });
  });
}

// ---------------------------------------------------------------------------
// Get current session (refreshes token automatically if expired)
// ---------------------------------------------------------------------------
export function getCurrentSession(): Promise<CognitoUserSession | null> {
  return new Promise((resolve) => {
    const pool = getPool();
    const user = pool.getCurrentUser();
    if (!user) return resolve(null);

    user.getSession((err: Error | null, session: CognitoUserSession | null) => {
      if (err || !session || !session.isValid()) return resolve(null);
      // Refresh cookie with the latest token
      setSessionCookie(session.getAccessToken().getJwtToken());
      resolve(session);
    });
  });
}

// ---------------------------------------------------------------------------
// Sign Out
// ---------------------------------------------------------------------------
export function signOut(): void {
  const pool = getPool();
  const user = pool.getCurrentUser();
  if (user) user.signOut();
  _pendingNewPasswordUser = null;
  clearSessionCookie();
}
