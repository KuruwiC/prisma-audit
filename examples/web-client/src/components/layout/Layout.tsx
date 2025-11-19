import type { ReactNode } from 'react';
import { Header } from './Header';

type LayoutProps = {
  children: ReactNode;
  currentPath: string;
  onNavigate: (path: string) => void;
};

export const Layout = ({ children, currentPath, onNavigate }: LayoutProps) => {
  return (
    <div className="min-h-screen bg-background">
      <Header currentPath={currentPath} onNavigate={onNavigate} />
      <main className="container mx-auto max-w-4xl px-4 py-8">{children}</main>
    </div>
  );
};
