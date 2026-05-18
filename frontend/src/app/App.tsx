import { RouterProvider, createBrowserRouter, Outlet, Navigate } from 'react-router';
import { useAuth0 } from '@auth0/auth0-react';
import Home from './components/Home';
import CreateTeam from './components/CreateTeam';
import JoinTeam from './components/JoinTeam';
import Lobby from './components/Lobby';
import GameSettings from './components/GameSettings';
import Gameplay from './components/Gameplay';
import GameResults from './components/GameResults';
import FriendsList from './components/FriendsList';
import AuthPage from './components/AuthPage';
import AuthCallback from './components/AuthCallback';
import AppLayout from './components/AppLayout';
import LoadingScreen from './components/LoadingScreen';
import SolanaTest from './components/SolanaTest';

function AuthGuard() {
  const { isAuthenticated, isLoading } = useAuth0();
  if (isLoading) return <LoadingScreen message="Authenticating..." />;
  if (!isAuthenticated) return <Navigate to="/auth" replace />;
  return (
    <div className="size-full">
      <Outlet />
    </div>
  );
}

const router = createBrowserRouter([
  { path: '/auth', Component: AuthPage },
  { path: '/callback', Component: AuthCallback },
  { path: '/solana-test', Component: SolanaTest },
  {
    path: '/',
    Component: AuthGuard,
    children: [
      {
        // AppLayout provides sidebar on desktop for all game routes
        Component: AppLayout,
        children: [
          { index: true, Component: Home },
          { path: 'create-team', Component: CreateTeam },
          { path: 'join-team', Component: JoinTeam },
          { path: 'lobby', Component: Lobby },
          { path: 'game-settings', Component: GameSettings },
          { path: 'gameplay', Component: Gameplay },
          { path: 'results', Component: GameResults },
          { path: 'friends', Component: FriendsList },
        ],
      },
    ],
  },
  { path: '*', element: <Navigate to="/" replace /> },
], {
  basename: import.meta.env.BASE_URL,
});

export default function App() {
  return <RouterProvider router={router} />;
}
