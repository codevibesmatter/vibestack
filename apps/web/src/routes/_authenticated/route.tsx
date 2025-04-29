import Cookies from 'js-cookie'
import { createFileRoute, Outlet, redirect } from '@tanstack/react-router'
import { cn } from '@/lib/utils'
import { SearchProvider } from '@/context/search-context'
import { SidebarProvider } from '@/components/ui/sidebar'
import { AppSidebar } from '@/components/layout/app-sidebar'
import SkipToMain from '@/components/skip-to-main'
import { useAuthStore } from '@/stores/authStore'

export const Route = createFileRoute('/_authenticated')({
  beforeLoad: ({ location }) => {
    // Check authentication state using Zustand store
    const isAuthenticated = useAuthStore.getState().isAuthenticated;
    const isLoadingAuth = useAuthStore.getState().isLoading; // Check loading state

    console.log(`[AUTH] beforeLoad (_authenticated): Is Authenticated? ${isAuthenticated}, Is Loading? ${isLoadingAuth}`);

    // If still loading auth status, don't redirect yet (wait for initial check)
    // Note: This simple check might cause a flicker if the initial check is slow.
    // A more robust solution might involve a dedicated loading state/component.
    if (isLoadingAuth) {
       console.log("[AUTH] beforeLoad (_authenticated): Auth status loading, deferring redirect check.");
       // Potentially return a loading indicator promise here if needed by router
       return; 
    }

    // If not authenticated (and not loading), redirect to sign-in
    if (!isAuthenticated) {
      console.log('[AUTH] beforeLoad (_authenticated): Not authenticated, redirecting to /sign-in.');
      throw redirect({
        to: '/sign-in', 
        search: {
          // Optionally preserve the intended destination
          redirect: location.href,
        }, 
        replace: true
      });
    }
    
    // If authenticated, proceed loading the route
    console.log('[AUTH] beforeLoad (_authenticated): Authenticated, proceeding.');
  },
  component: RouteComponent,
})

function RouteComponent() {
  const defaultOpen = Cookies.get('sidebar_state') !== 'false'
  return (
    <SearchProvider>
      <SidebarProvider defaultOpen={defaultOpen}>
        <SkipToMain />
        <AppSidebar />
        <div
          id='content'
          className={cn(
            'ml-auto w-full max-w-full',
            'peer-data-[state=collapsed]:w-[calc(100%-var(--sidebar-width-icon)-1rem)]',
            'peer-data-[state=expanded]:w-[calc(100%-var(--sidebar-width))]',
            'sm:transition-[width] sm:duration-200 sm:ease-linear',
            'flex h-svh flex-col',
            'group-data-[scroll-locked=1]/body:h-full',
            'has-[main.fixed-main]:group-data-[scroll-locked=1]/body:h-svh'
          )}
        >
          <Outlet />
        </div>
      </SidebarProvider>
    </SearchProvider>
  )
}
