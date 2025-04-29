import { create } from 'zustand';

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
}

interface AuthActions {
  setAuthenticated: (user: UserInfo) => void;
  setUnauthenticated: () => void;
  setLoading: (loading: boolean) => void;
}

export const useAuthStore = create<AuthState & AuthActions>((set) => ({
  // Initial state assumes we need to check with the backend
  isAuthenticated: false,
  user: null,
  isLoading: true, // Start loading until initial check completes

  setAuthenticated: (user) => {
    console.log("[AUTH] Setting state to AUTHENTICATED. User:", user);
    set({ isAuthenticated: true, user: user, isLoading: false });
  },

  setUnauthenticated: () => {
    console.log("[AUTH] Setting state to UNAUTHENTICATED.");
    set({ isAuthenticated: false, user: null, isLoading: false });
  },

  setLoading: (loading) => {
    // console.log(`[AUTH] Setting loading state: ${loading}`);
    set({ isLoading: loading });
  },
}));

console.log("[AUTH] Zustand auth store initialized. Initial state:", useAuthStore.getState());
