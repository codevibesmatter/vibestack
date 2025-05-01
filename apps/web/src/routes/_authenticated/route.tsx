import Cookies from 'js-cookie'
import { createFileRoute, Outlet, redirect } from '@tanstack/react-router'
import { cn } from '@/lib/utils'
import { SearchProvider } from '@/context/search-context'
import { SidebarProvider } from '@/components/ui/sidebar'
import { AppSidebar } from '@/components/layout/app-sidebar'
import SkipToMain from '@/components/skip-to-main'
import { useAuthStore } from '@/stores/authStore'

export const Route = createFileRoute('/_authenticated')({
  beforeLoad: async ({ location }) => {
    // TEMPORARILY REMOVED to test login navigation
    // await useAuthStore.getState().ensureAuthInitialized(); 

    // Check the auth state directly
    const isAuthenticated = useAuthStore.getState().isAuthenticated;

    console.log(`[AUTH] beforeLoad (_authenticated) check: Is Authenticated? ${isAuthenticated}`);

    // If not authenticated, redirect to sign-in
    if (!isAuthenticated) {
      console.log('[AUTH] beforeLoad (_authenticated): Not authenticated, redirecting to /sign-in.');
      throw redirect({
        to: '/sign-in', 
        search: {
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
