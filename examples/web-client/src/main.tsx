import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';
import { ActorProvider } from './lib/actor';
import { RollbackProvider } from './lib/rollbacks';
import './styles.css';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 1000 } } });

const root = document.getElementById('root');
if (!root) throw new Error('The #root element is missing from index.html');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ActorProvider>
        <RollbackProvider>
          <App />
        </RollbackProvider>
      </ActorProvider>
    </QueryClientProvider>
  </StrictMode>,
);
