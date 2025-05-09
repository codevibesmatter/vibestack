import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

// No longer need js-cookie
// import Cookies from 'js-cookie';

// Define a simpler state focused on auth status and user data
interface UserInfo {
  id: string;
  email?: string;
  // Add other relevant fields from your User model
}

interface AuthState {
  isAuthenticated: boolean;
  user: UserInfo | null;
  isLoading: boolean; // Tracks initial auth status check
  sessionExpiresAt: string | null; // Stores session expiration date
  lastOnlineCheck: string | null; // Stores when we last successfully checked with the server
}

interface AuthActions {
  setAuthenticated: (user: UserInfo, expiresAt?: string | null) => void;
  setUnauthenticated: () => void;
  setLoading: (loading: boolean) => void;
  ensureAuthInitialized: () => Promise<void>;
  updateSessionExpiry: (expiresAt: string) => void;
  isSessionExpired: () => boolean;
}

export const useAuthStore = create<AuthState & AuthActions>()(
  persist(
    (set, get) => ({
      // Initial state assumes we need to check with the backend
      isAuthenticated: false,
      user: null,
      isLoading: true, // Start loading until initial check completes
      sessionExpiresAt: null,
      lastOnlineCheck: null,

      setAuthenticated: (user, expiresAt = null) => {
        console.log("[AUTH] Setting state to AUTHENTICATED. User:", user);
        set({ 
          isAuthenticated: true, 
          user: user, 
          isLoading: false,
          sessionExpiresAt: expiresAt,
          lastOnlineCheck: new Date().toISOString()
        });
      },

      setUnauthenticated: () => {
        console.log("[AUTH] Setting state to UNAUTHENTICATED.");
        set({ 
          isAuthenticated: false, 
          user: null, 
          isLoading: false,
          sessionExpiresAt: null 
        });
      },

      setLoading: (loading) => {
        // console.log(`[AUTH] Setting loading state: ${loading}`);
        set({ isLoading: loading });
      },

      updateSessionExpiry: (expiresAt) => {
        console.log(`[AUTH] Updating session expiry to: ${expiresAt}`);
        set({ 
          sessionExpiresAt: expiresAt,
          lastOnlineCheck: new Date().toISOString()
        });
      },

      isSessionExpired: () => {
        const { sessionExpiresAt } = get();
        
        if (!sessionExpiresAt) {
          return true; // If no expiry date is set, consider it expired
        }
        
        try {
          const expiryDate = new Date(sessionExpiresAt);
          const now = new Date();
          return now >= expiryDate;
        } catch (error) {
          console.error("[AUTH] Error checking session expiry:", error);
          return true; // On error, consider session expired
        }
      },

      // New function to ensure authentication check has completed
      ensureAuthInitialized: () => {
        return new Promise((resolve) => {
          const state = get(); // Get current state
          if (!state.isLoading) {
            // If not loading, resolve immediately
            resolve();
          } else {
            // If loading, subscribe to changes and wait for isLoading to become false
            const unsubscribe = useAuthStore.subscribe((currentState) => {
              if (!currentState.isLoading) {
                resolve();
                unsubscribe(); // Clean up the subscription
              }
            });
          }
        });
      },
    }),
    {
      name: 'auth-storage', // Name for localStorage key
      storage: createJSONStorage(() => localStorage),
      // Only persist these fields
      partialize: (state) => ({
        isAuthenticated: state.isAuthenticated,
        user: state.user,
        sessionExpiresAt: state.sessionExpiresAt,
        lastOnlineCheck: state.lastOnlineCheck,
      }),
    }
  )
);

console.log("[AUTH] Zustand auth store initialized. Initial state:", useAuthStore.getState());
