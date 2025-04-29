import { QueryClient, useQuery } from '@tanstack/react-query'
import { createRootRouteWithContext, Outlet } from '@tanstack/react-router'
import { ReactQueryDevtools } from '@tanstack/react-query-devtools'
import { TanStackRouterDevtools } from '@tanstack/react-router-devtools'
import { Toaster } from '@/components/ui/sonner'
import { NavigationProgress } from '@/components/navigation-progress'
import GeneralError from '@/features/errors/general-error'
import NotFoundError from '@/features/errors/not-found-error'
import { useEffect } from 'react'
import axios from 'axios'
// import { useObserve } from '@legendapp/state/react' // Remove Legend State hook
// import { authState$ } from '@/stores/authStore' // Remove Legend State store import
import { useAuthStore } from '@/stores/authStore' // Import Zustand store hook
import { redirectToLogin } from '@/lib/auth' // Adjust path if needed

// --- Define the function to fetch user data ---
const fetchUser = async () => {
    console.log("[AUTH] Fetching user data from /api/auth/me...");
    const response = await axios.get('/api/auth/me', { withCredentials: true });
    console.log("[AUTH] /api/auth/me response:", response.data);
    return response.data; // Assuming backend returns UserInfo { id, email?, ... }
};

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient
}>()({
  component: function RootComponent() {
    // Get actions and state from Zustand store
    const { setAuthenticated, setUnauthenticated, setLoading } = useAuthStore();
    const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
    const isLoading = useAuthStore((state) => state.isLoading);

    // Use react-query to fetch user data on initial mount if needed
    const { isLoading: isUserLoading, isError, error, data: user } = useQuery({
        queryKey: ['authUser'],
        queryFn: fetchUser,
        retry: false,
        refetchOnWindowFocus: false,
        enabled: isLoading, // Run query only during the initial loading phase
        staleTime: 5 * 60 * 1000, // Consider data fresh for 5 mins
        gcTime: 15 * 60 * 1000, // Keep data in cache for 15 mins
    });

    useEffect(() => {
         console.log(`[AUTH] RootComponent effect: isUserLoading=${isUserLoading}, isError=${isError}, isAuthenticated=${isAuthenticated}, isLoadingStore=${isLoading}`);

        // Update store's loading state based on query's loading state only during initial load
        if (isLoading && isUserLoading !== isLoading) {
             setLoading(isUserLoading);
        }

        // Only process final state when the query is done and we were in initial load phase
        if (!isUserLoading && isLoading) { 
            if (isError) {
                console.log("[AUTH] /api/auth/me call failed.", error);
                setUnauthenticated();
                const status = (error as any)?.response?.status;
                if (status === 401 || status === 403) {
                    console.log("[AUTH] Unauthorized error, redirecting to login...");
                     redirectToLogin();
                } else {
                     console.error("Error fetching user:", error);
                     // Maybe show a global error?
                }
            } else if (user) {
                console.log("[AUTH] /api/auth/me call successful. Setting authenticated.");
                setAuthenticated(user); // Pass user data to store
            } else {
                 console.warn("[AUTH] /api/auth/me call succeeded but returned no user data.");
                 setUnauthenticated();
                 redirectToLogin(); // Treat missing user as unauthenticated
            }
        }
    }, [isUserLoading, isError, error, user, setAuthenticated, setUnauthenticated, setLoading, isLoading, isAuthenticated]);


    // Show loading indicator while checking auth status via the query
    if (isLoading) { // Rely on the store's isLoading state
        return <div>Loading authentication...</div>;
    }

    // If authenticated, render the main app layout
    if (isAuthenticated) {
      return (
        <>
          <NavigationProgress />
          <Outlet />
          <Toaster duration={50000} />
          {import.meta.env.MODE === 'development' && (
            <>
              <ReactQueryDevtools buttonPosition='bottom-left' />
              <TanStackRouterDevtools position='bottom-right' />
            </>
          )}
        </>
      );
    }

    // Otherwise (not loading, not authenticated), show loading/redirecting message
    // The useEffect should handle the actual redirect trigger
    return <div>Redirecting to login...</div>;
  },
  notFoundComponent: NotFoundError,
  errorComponent: GeneralError,
})
