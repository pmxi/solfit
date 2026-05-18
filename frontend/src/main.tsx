import { Buffer } from 'buffer';
// Anchor + @solana/web3.js reach for Node's Buffer global; Vite doesn't polyfill it.
(globalThis as { Buffer?: typeof Buffer }).Buffer = Buffer;

import { createRoot } from 'react-dom/client';
import { Auth0Provider } from '@auth0/auth0-react';
import App from './app/App.tsx';
import { GameProvider } from './context/GameContext.tsx';
import { AUTH0_DOMAIN, AUTH0_CLIENT_ID } from './config.ts';
import './styles/index.css';

const appBaseUrl = `${window.location.origin}${import.meta.env.BASE_URL}`;

createRoot(document.getElementById('root')!).render(
  <Auth0Provider
    domain={AUTH0_DOMAIN}
    clientId={AUTH0_CLIENT_ID}
    authorizationParams={{
      redirect_uri: new URL('callback', appBaseUrl).toString(),
      // Request offline_access so Auth0 issues refresh tokens
      scope: 'openid profile email offline_access',
    }}
    // Cache tokens in localStorage so the session survives page refresh
    cacheLocation="localstorage"
    useRefreshTokens={true}
  >
    <GameProvider>
      <App />
    </GameProvider>
  </Auth0Provider>
);
