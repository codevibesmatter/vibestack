import React from 'react';
import { createLazyFileRoute } from '@tanstack/react-router';
import PlatformTestPage from '../pages/PlatformTestPage';

// Define the route
export const Route = createLazyFileRoute('/platform-test')({
  component: PlatformTestRoute
});

// Create the route component
function PlatformTestRoute() {
  return <PlatformTestPage />;
} 