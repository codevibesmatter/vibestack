import { createFileRoute, Outlet } from '@tanstack/react-router'

// This route acts as a layout for the /debug/* paths
// It doesn't add UI itself but ensures the /debug path segment exists
// The path '/_authenticated/debug' is inferred from the directory structure
export const Route = createFileRoute('/_authenticated/debug')({
  component: () => <Outlet />,
});