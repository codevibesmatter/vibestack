import { createRootRoute, Outlet } from '@tanstack/react-router'
import { TanStackRouterDevtools } from '@tanstack/router-devtools'
import { NavBar } from '../components/NavBar'

export const Route = createRootRoute({
  component: () => (
    <div className="min-h-screen bg-[#1a1a1a]">
      <NavBar />
      <main className="container mx-auto px-4 py-8">
        <Outlet />
      </main>
      <TanStackRouterDevtools />
    </div>
  )
}) 