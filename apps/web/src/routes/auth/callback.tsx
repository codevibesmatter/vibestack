import React, { useEffect } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';

export const Route = createFileRoute('/auth/callback')({
  component: AuthCallbackComponent,
});

// This component now mainly exists just to show *something* after the 
// OpenAuth -> Backend Callback -> Frontend redirect dance.
function AuthCallbackComponent() {
  const navigate = useNavigate();

  useEffect(() => {
    // Redirect to the main app immediately after rendering
    console.log("[AUTH] Frontend callback rendered, navigating to root...");
    navigate({ to: '/', replace: true });
  }, [navigate]);

  // You could show a loading indicator or a success message
  return <div>Login successful! Redirecting...</div>;
} 