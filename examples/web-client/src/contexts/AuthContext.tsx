import { createContext, type ReactNode, useContext, useEffect, useState } from 'react';
import { apiClient } from '../lib/api-client';
import type { User } from '../types/api';

type AuthContextType = {
  user: User | null;
  isAuthenticated: boolean;
  login: (email: string) => Promise<void>;
  logout: () => void;
  refreshUser: () => Promise<void>;
  isLoading: boolean;
};

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
};

type AuthProviderProps = {
  children: ReactNode;
};

const STORAGE_KEY = 'prisma-audit-user';

export const AuthProvider = ({ children }: AuthProviderProps) => {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Load user from localStorage on mount
  useEffect(() => {
    const storedUser = localStorage.getItem(STORAGE_KEY);
    if (storedUser) {
      try {
        const parsedUser = JSON.parse(storedUser) as User;
        setUser(parsedUser);
        // Set actor context for API client
        apiClient.setActorContext(parsedUser.id, 'User', parsedUser.name || parsedUser.email);
      } catch (error) {
        console.error('Failed to parse stored user:', error);
        localStorage.removeItem(STORAGE_KEY);
      }
    }
    setIsLoading(false);
  }, []);

  const login = async (email: string) => {
    setIsLoading(true);
    try {
      const userData = await apiClient.login({ email });
      setUser(userData);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(userData));
      // Set actor context for API client
      apiClient.setActorContext(userData.id, 'User', userData.name || userData.email);
    } finally {
      setIsLoading(false);
    }
  };

  const logout = () => {
    setUser(null);
    localStorage.removeItem(STORAGE_KEY);
    apiClient.clearActorContext();
  };

  const refreshUser = async () => {
    if (!user) return;

    try {
      const updatedUser = await apiClient.getProfile(user.id);
      setUser(updatedUser);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(updatedUser));
    } catch (error) {
      console.error('Failed to refresh user:', error);
    }
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        isAuthenticated: !!user,
        login,
        logout,
        refreshUser,
        isLoading,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};
