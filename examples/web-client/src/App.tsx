import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { AdminPage } from './components/admin/AdminPage';
import { LoginForm } from './components/auth/LoginForm';
import { FeedPage } from './components/feed/FeedPage';
import { Layout } from './components/layout/Layout';
import { PostDetailPage } from './components/post/PostDetailPage';
import { ProfilePage } from './components/profile/ProfilePage';
import { ThemeProvider } from './components/theme-provider';
import { UserProfilePage } from './components/user/UserProfilePage';
import { AuthProvider, useAuth } from './contexts/AuthContext';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: true, // ウィンドウフォーカス時に自動更新
      refetchOnReconnect: true, // ネットワーク再接続時に自動更新
      staleTime: 30000, // 30秒間はデータをfreshとみなす
      retry: 1,
    },
  },
});

const Router = () => {
  const [currentPath, setCurrentPath] = useState(() => window.location.pathname || '/');

  const navigate = (path: string) => {
    setCurrentPath(path);
    window.history.pushState({}, '', path);
  };

  const renderPage = () => {
    // Handle /post/:id pattern
    if (currentPath.startsWith('/post/')) {
      const postId = currentPath.split('/post/')[1];
      return (
        <PostDetailPage
          postId={postId}
          onBack={() => navigate('/')}
          onUserClick={(userId) => navigate(`/user/${userId}`)}
        />
      );
    }

    // Handle /user/:id pattern
    if (currentPath.startsWith('/user/')) {
      const userId = currentPath.split('/user/')[1];
      return <UserProfilePage userId={userId} onBack={() => navigate('/')} />;
    }

    switch (currentPath) {
      case '/':
        return (
          <FeedPage
            onPostClick={(postId) => navigate(`/post/${postId}`)}
            onUserClick={(userId) => navigate(`/user/${userId}`)}
          />
        );
      case '/profile':
        return <ProfilePage />;
      case '/admin':
        return <AdminPage />;
      default:
        return (
          <FeedPage
            onPostClick={(postId) => navigate(`/post/${postId}`)}
            onUserClick={(userId) => navigate(`/user/${userId}`)}
          />
        );
    }
  };

  return (
    <Layout currentPath={currentPath} onNavigate={navigate}>
      {renderPage()}
    </Layout>
  );
};

const AppContent = () => {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-muted-foreground">Loading...</p>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <LoginForm />;
  }

  return <Router />;
};

const App = () => {
  return (
    <ThemeProvider defaultTheme="system" storageKey="vite-ui-theme">
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <AppContent />
        </AuthProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
};

export default App;
