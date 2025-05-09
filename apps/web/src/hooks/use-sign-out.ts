import { useNavigate } from '@tanstack/react-router';
import { useAuthStore } from '@/stores/authStore';
import { useSyncContext } from '@/sync/SyncContext';
import { authClient } from '@/lib/auth';

/**
 * Custom hook for handling the sign-out process, including:
 * 1. Starting navigation to sign-in page
 * 2. Disconnecting from sync
 * 3. Signing out from the authentication provider
 * 4. Updating local auth state
 */
export function useSignOut() {
  const { setUnauthenticated } = useAuthStore();
  const { disconnect, setAutoConnect } = useSyncContext();
  const navigate = useNavigate();

  const signOut = async () => {
    try {
      console.log('[AUTH] Beginning sign-out process...');
      
      // Step 1: Disable sync auto-connect to prevent reconnection during sign-out
      console.log('[SYNC] Disabling auto-connect during sign-out...');
      setAutoConnect(false);
      
      // Step 2: Trigger navigation first to take us away from authenticated routes
      console.log('[AUTH] Starting navigation to sign-in page');
      // Use window.location for a full page navigation away from the dashboard
      // This needs to happen before we disconnect sync and change auth state
      window.location.href = '/sign-in';
      
      // Step 3: Small delay to ensure navigation has started
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Step 4: Disconnect from sync
      console.log('[SYNC] Disconnecting from sync during logout...');
      disconnect();
      
      // Step 5: Sign out from authentication provider
      console.log('[AUTH] Calling authClient.signOut()...');
      await authClient.signOut();
      console.log('[AUTH] authClient.signOut() successful');
      
      // Step 6: Clear local authentication state
      console.log('[AUTH] Clearing frontend auth state');
      setUnauthenticated();
      
      return true;
    } catch (error) {
      console.error('[AUTH] Error during sign-out process:', error);
      
      // On error, still try to navigate away
      window.location.href = '/sign-in';
      
      return false;
    }
  };

  return { signOut };
} 