import { useAuth } from '../../contexts/AuthContext';
import { Button } from '../ui/button';

type HeaderProps = {
  currentPath: string;
  onNavigate: (path: string) => void;
};

export const Header = ({ currentPath, onNavigate }: HeaderProps) => {
  const { user, logout } = useAuth();

  const getAvatarUrl = () => {
    return user?.profile?.avatar?.avatarImage?.imageUrl || 'https://i.pravatar.cc/150?img=1';
  };

  const getUserDisplayName = () => {
    return user?.name || user?.email || 'User';
  };

  return (
    <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="container mx-auto flex h-16 items-center justify-between px-4">
        <div className="flex items-center gap-6">
          <h1 className="cursor-pointer text-xl font-bold hover:text-primary" onClick={() => onNavigate('/')}>
            Prisma Audit Demo
          </h1>

          <nav className="flex gap-4">
            <Button variant={currentPath === '/' ? 'default' : 'ghost'} onClick={() => onNavigate('/')}>
              Feed
            </Button>
            <Button variant={currentPath === '/profile' ? 'default' : 'ghost'} onClick={() => onNavigate('/profile')}>
              Profile
            </Button>
            <Button variant={currentPath === '/admin' ? 'default' : 'ghost'} onClick={() => onNavigate('/admin')}>
              Admin
            </Button>
          </nav>
        </div>

        <div className="flex items-center gap-4">
          <div className="flex items-center gap-3">
            <img
              src={getAvatarUrl()}
              alt={getUserDisplayName()}
              className="aspect-square h-8 w-8 rounded-full object-cover"
            />
            <span className="text-sm font-medium">{getUserDisplayName()}</span>
          </div>
          <Button variant="outline" onClick={logout}>
            Logout
          </Button>
        </div>
      </div>
    </header>
  );
};
