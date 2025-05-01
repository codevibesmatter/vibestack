import { QueryClient } from '@tanstack/react-query'
import { createRootRouteWithContext, Outlet } from '@tanstack/react-router'
import { TanStackRouterDevtools } from '@tanstack/react-router-devtools'
import { Toaster } from '@/components/ui/sonner'
import { NavigationProgress } from '@/components/navigation-progress'
import GeneralError from '@/features/errors/general-error'
import NotFoundError from '@/features/errors/not-found-error'
import { useEffect } from 'react'
import { useAuthStore } from '@/stores/authStore' // Import Zustand store hook
import { authClient } from '@/lib/auth' // Import authClient instead of useSession hook directly

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient
}>()({
  component: function RootComponent() {
    // Get actions and state from Zustand store
    const {
      setAuthenticated,
      setUnauthenticated,
      setLoading,
      isAuthenticated,
      isLoading,
    } = useAuthStore();

    // Use Better Auth session hook via the client instance
    const { data: sessionData, isPending, error: sessionError } = authClient.useSession(); 

    useEffect(() => {
      console.log(`[AUTH] RootComponent effect: Session isPending=${isPending}, Store isLoading=${isLoading}, Error=${sessionError}`);

      // Update loading state based on isPending
      if (isPending !== isLoading) {
        setLoading(isPending);
      }

      // Process final state only when not pending
      if (!isPending) {
        if (sessionError) {
          // Handle error (likely means unauthenticated or server issue)
          console.error("[AUTH] Session check error:", sessionError);
          // Only update if state is not already unauthenticated or if it's loading
          if (isAuthenticated || isLoading) { 
             console.log("[AUTH] Session error implies unauthenticated. Setting store state.");
             setUnauthenticated(); // Set unauthenticated on error
             // No need to set loading false here, setUnauthenticated does it
          }
        } else if (sessionData?.user) {
          // Handle successful authentication
          // Only update if not already authenticated with the same user, or if loading
          if (!isAuthenticated || isLoading || useAuthStore.getState().user?.id !== sessionData.user.id) { 
            console.log("[AUTH] Session data received. Setting authenticated state.", sessionData.user);
            setAuthenticated({ id: sessionData.user.id, email: sessionData.user.email });
            // No need to set loading false here, setAuthenticated does it
          }
        } else {
          // Handle case where session check completes without error but no user (unauthenticated)
          // Only update if state is currently authenticated or loading
          if (isAuthenticated || isLoading) { 
            // console.log("[AUTH] Session check successful but no user data (unauthenticated). Setting store state ONLY if currently authenticated or loading.");
            // REMOVED: setUnauthenticated(); // DO NOT overwrite state if login/signup just happened
            // No need to set loading false here, setUnauthenticated does it
          }
        }
         // Ensure loading is false *after* processing, only if it was true
         // This check might be redundant now as setAuthenticated/setUnauthenticated handle it.
         // Consider removing if confirmed redundant.
         // if (useAuthStore.getState().isLoading) setLoading(false); 
      }
    // Watch session hook results for changes
    }, [sessionData, isPending, sessionError, setAuthenticated, setUnauthenticated, setLoading, isAuthenticated, isLoading]);

    // Show loading indicator 
    if (isLoading) {
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
              <TanStackRouterDevtools position='bottom-right' />
            </>
          )}
        </>
      );
    }

    // Otherwise (not loading, not authenticated), render the public part of the app
    // This could be public routes, or handled by beforeLoad redirect for protected ones.
    // Rendering Outlet allows public routes (like /sign-in) to work.
    return (
      <>
        <Outlet /> 
        <Toaster duration={50000} />
      </>
    );
  },
  notFoundComponent: NotFoundError,
  errorComponent: GeneralError,
})
