import { QueryClient } from '@tanstack/react-query'
import { createRootRouteWithContext, Outlet, useRouter, useLocation } from '@tanstack/react-router'
import { TanStackRouterDevtools } from '@tanstack/react-router-devtools'
import { Toaster } from '@/components/ui/sonner'
import { NavigationProgress } from '@/components/navigation-progress'
import GeneralError from '@/features/errors/general-error'
import NotFoundError from '@/features/errors/not-found-error'
import { useEffect, useState } from 'react'
import { useAuthStore } from '@/stores/authStore' // Import Zustand store hook
import { authClient } from '@/lib/auth' // Import authClient instead of useSession hook directly
import { Skeleton } from '@/components/ui/skeleton'
import { SidebarMenuSkeleton } from '@/components/ui/sidebar'

// Loading skeleton component for authentication
function AuthLoadingSkeleton() {
  return (
    <div className="h-svh w-full flex flex-col p-4 md:p-8">
      {/* App header skeleton */}
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center">
          <Skeleton className="h-8 w-8 rounded-md mr-3" />
          <Skeleton className="h-6 w-32" />
        </div>
        <div className="flex items-center gap-2">
          <Skeleton className="h-8 w-8 rounded-full" />
          <Skeleton className="h-8 w-8 rounded-full" />
        </div>
      </div>
      
      {/* Main content area skeleton */}
      <div className="flex flex-1 gap-4">
        {/* Sidebar skeleton */}
        <div className="hidden md:flex flex-col w-60 gap-2 pr-4">
          <Skeleton className="h-10 w-full mb-4" />
          <SidebarMenuSkeleton showIcon={true} />
          <SidebarMenuSkeleton showIcon={true} />
          <SidebarMenuSkeleton showIcon={true} />
          <SidebarMenuSkeleton showIcon={true} />
          <SidebarMenuSkeleton showIcon={true} />
          <div className="mt-4">
            <SidebarMenuSkeleton showIcon={true} />
            <SidebarMenuSkeleton showIcon={true} />
          </div>
        </div>
        
        {/* Main content skeleton */}
        <div className="flex-1">
          <Skeleton className="h-8 w-1/3 mb-4" />
          <Skeleton className="h-32 w-full mb-4" />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-28 w-full" />
          </div>
          <div className="grid grid-cols-1 gap-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        </div>
      </div>
    </div>
  );
}

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
      sessionExpiresAt,
      isSessionExpired,
      updateSessionExpiry
    } = useAuthStore();
    
    // Get router for navigation
    const router = useRouter();
    
    // Get current location
    const location = useLocation();

    // Check online status
    const [isOnline, setIsOnline] = useState(navigator.onLine);
    
    // Listen for online/offline events
    useEffect(() => {
      const handleOnline = () => setIsOnline(true);
      const handleOffline = () => setIsOnline(false);
      
      window.addEventListener('online', handleOnline);
      window.addEventListener('offline', handleOffline);
      
      return () => {
        window.removeEventListener('online', handleOnline);
        window.removeEventListener('offline', handleOffline);
      };
    }, []);

    // Use Better Auth session hook via the client instance
    const { data: sessionData, isPending, error: sessionError } = authClient.useSession(); 
    
    // Handle redirection for authenticated users on auth pages
    useEffect(() => {
      if (isAuthenticated && !isLoading) {
        // If we're authenticated but on an auth page, redirect to dashboard
        const currentPath = location.pathname;
        if (currentPath === '/sign-in' || currentPath === '/sign-up' || 
            currentPath === '/sign-in-2' || currentPath === '/forgot-password') {
          console.log('[AUTH] Detected authenticated user on auth page, redirecting to dashboard');
          router.navigate({ to: '/', replace: true });
        }
      }
    }, [isAuthenticated, isLoading, location.pathname, router]);

    useEffect(() => {
      console.log(`[AUTH] RootComponent effect: Session isPending=${isPending}, Store isLoading=${isLoading}, Error=${sessionError}, Online=${isOnline}`);

      if (isPending) {
        // We are waiting for the session check
        if (!isOnline && isAuthenticated && !isSessionExpired()) {
          // Offline with a valid cached session, show content immediately.
          if (isLoading) { // Only change if currently true
            console.log("[AUTH] Offline & Pending: Using cached session, setting loading to false.");
            setLoading(false);
          }
        } else {
          // Online, or offline without a valid cache. We must wait for the session check.
          if (!isLoading) { // Only change if currently false and we need to load
            setLoading(true);
          }
        }
      } else { // Session check is NOT pending (!isPending)
        // Logic for when session check has completed (successfully or with error)
        if (sessionError) {
          console.error("[AUTH] Session check error:", sessionError);
          
          // CRITICAL OFFLINE HANDLING:
          // If we are offline AND we have a persisted authenticated session that's not expired,
          // we should trust the persisted state and NOT set unauthenticated due to a network error.
          if (!isOnline && useAuthStore.getState().isAuthenticated && !useAuthStore.getState().isSessionExpired()) {
            console.log("[AUTH] Offline: Server check failed but cached session is valid. Maintaining auth state.");
            if (isLoading) setLoading(false); // Ensure loading is false
          } else {
            // Online with an error, or offline without a valid cached session:
            // This implies a real authentication issue or an expired/missing offline session.
            if (useAuthStore.getState().isAuthenticated || useAuthStore.getState().isLoading) {
              console.log("[AUTH] Session error implies unauthenticated (or offline with no/invalid cache). Setting store state.");
              setUnauthenticated();
            } else if (isLoading) { // If already unauth but was loading
              setLoading(false);
            }
          }
        } else if (sessionData?.user) {
          // Handle successful authentication
          let sessionExpiryString: string | null = null;
          if (sessionData.session?.expiresAt) {
            if (sessionData.session.expiresAt instanceof Date) {
              sessionExpiryString = sessionData.session.expiresAt.toISOString();
            } else if (typeof sessionData.session.expiresAt === 'string') {
              sessionExpiryString = sessionData.session.expiresAt;
            }
          }
          
          if (!isAuthenticated || isLoading || useAuthStore.getState().user?.id !== sessionData.user.id) {
            console.log("[AUTH] Session data received. Setting authenticated state.", sessionData.user);
            setAuthenticated(
              { id: sessionData.user.id, email: sessionData.user.email },
              sessionExpiryString
            );
          } else if (sessionExpiryString && sessionExpiresAt !== sessionExpiryString) {
            console.log("[AUTH] Session expiry updated:", sessionExpiryString);
            updateSessionExpiry(sessionExpiryString);
          } else {
            if (isLoading) setLoading(false);
          }
        } else {
          // No sessionError, but no sessionData.user (e.g., valid response, but user is not logged in)
          // This means the user is genuinely not authenticated on the server.
          if (isAuthenticated || isLoading) {
            console.log("[AUTH] Session check successful but no user data (unauthenticated). Setting store state.");
            setUnauthenticated();
          } else if (isLoading) { // If already unauth but was loading
             setLoading(false);
          }
        }
      }
    }, [
      sessionData, 
      isPending, 
      sessionError, 
      isOnline,
      setAuthenticated, 
      setUnauthenticated, 
      setLoading, 
      isAuthenticated, 
      isLoading,
      isSessionExpired,
      sessionExpiresAt,
      updateSessionExpiry
    ]);

    // Show loading indicator 
    if (isLoading) {
      return <AuthLoadingSkeleton />;
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
