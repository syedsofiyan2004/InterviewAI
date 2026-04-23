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

interface AuthUser {
  email: string;
  accessToken: string;
}

interface AuthContextType {
  user: AuthUser | null;
  isLoading: boolean;
  signOut: () => void;
  refreshSession: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  isLoading: true,
  signOut: () => {},
  refreshSession: async () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

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

  const handleSignOut = () => {
    cognitoSignOut();
    setUser(null);
    window.location.href = '/login';
  };

  return (
    <AuthContext.Provider
      value={{ user, isLoading, signOut: handleSignOut, refreshSession: loadSession }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
