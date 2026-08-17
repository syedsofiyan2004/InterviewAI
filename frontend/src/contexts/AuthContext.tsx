'use client';

import {
  createContext,
  useContext,
  useEffect,
  useState,
  ReactNode,
} from 'react';
import { CognitoUserSession } from 'amazon-cognito-identity-js';
import { getCurrentSession, signOut as cognitoSignOut } from '@/lib/auth';
import { api, type MeResponse, type AdminTier, type BaseRole } from '@/lib/api';

interface AuthUser {
  email: string;
  accessToken: string;
}

/**
 * Ordered admin tiers. Mirrors TIER_RANK in infrastructure/lambdas/api-handler/authz.ts.
 * Used only to decide what to render — every gated surface is also checked
 * server-side, so a tampered client buys nothing.
 */
const TIER_RANK: Record<AdminTier, number> = {
  VIEWER: 1,
  REVIEWER: 2,
  APPROVER: 3,
  OWNER: 4,
};

interface AuthContextType {
  user: AuthUser | null;
  isLoading: boolean;
  /** Server-issued identity from GET /me. Null until loaded, or if the call fails. */
  profile: MeResponse | null;
  isProfileLoading: boolean;
  baseRole: BaseRole | null;
  tier: AdminTier | null;
  /** base_role === 'ADMIN' AND an active grant exists. Both layers, never collapsed. */
  isAdmin: boolean;
  hasTier: (minTier: AdminTier) => boolean;
  signOut: () => void;
  refreshSession: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  isLoading: true,
  profile: null,
  isProfileLoading: true,
  baseRole: null,
  tier: null,
  isAdmin: false,
  hasTier: () => false,
  signOut: () => {},
  refreshSession: async () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [profile, setProfile] = useState<MeResponse | null>(null);
  const [isProfileLoading, setIsProfileLoading] = useState(true);

  const loadSession = async () => {
    try {
      const session: CognitoUserSession | null = await getCurrentSession();
      if (session) {
        const payload = session.getIdToken().decodePayload();
        setUser({
          email: payload.email as string,
          accessToken: session.getAccessToken().getJwtToken(),
        });
      } else {
        setUser(null);
      }
    } catch {
      setUser(null);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadSession();
  }, []);

  // Role and tier come from the server, never from a decoded ID-token claim —
  // a claim is client-visible and the Cognito group alone grants nothing.
  useEffect(() => {
    if (isLoading) return;
    if (!user) {
      setProfile(null);
      setIsProfileLoading(false);
      return;
    }

    let cancelled = false;
    setIsProfileLoading(true);
    api
      .getMe()
      .then((me) => {
        if (!cancelled) setProfile(me);
      })
      .catch(() => {
        // Fail closed: no profile means no admin nav, no candidate surfaces.
        if (!cancelled) setProfile(null);
      })
      .finally(() => {
        if (!cancelled) setIsProfileLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [user, isLoading]);

  const handleSignOut = () => {
    cognitoSignOut();
    setUser(null);
    setProfile(null);
    window.location.href = '/login';
  };

  const baseRole = profile?.baseRole ?? null;
  const tier = profile?.tier ?? null;
  const isAdmin = Boolean(profile?.isAdmin);
  const hasTier = (minTier: AdminTier) =>
    isAdmin && tier !== null && TIER_RANK[tier] >= TIER_RANK[minTier];

  return (
    <AuthContext.Provider
      value={{
        user,
        isLoading,
        profile,
        isProfileLoading,
        baseRole,
        tier,
        isAdmin,
        hasTier,
        signOut: handleSignOut,
        refreshSession: loadSession,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
