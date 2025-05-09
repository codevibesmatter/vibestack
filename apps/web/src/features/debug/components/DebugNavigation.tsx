import React from 'react';
import { Link } from '@tanstack/react-router';
import { Card, CardContent } from '@/components/ui/card';

export function DebugNavigation() {
  const debugRoutes = [
    { path: '/debug/database', label: 'Database' },
    { path: '/debug/sync', label: 'Sync' },
    { path: '/debug/sync-changes', label: 'Sync Changes' },
    { path: '/debug/live-query', label: 'Live Query' },
    { path: '/debug/data-table', label: 'Data Table' },
    { path: '/debug/auth', label: 'Auth' },
  ];
  
  return (
    <Card className="mt-8">
      <CardContent className="pt-6">
        <div className="flex flex-wrap gap-2">
          <span className="font-medium mr-2">Debug Pages:</span>
          {debugRoutes.map((route) => (
            <Link
              key={route.path}
              to={route.path}
              className="px-3 py-1 bg-muted rounded-md hover:bg-muted/80 text-sm"
              activeProps={{ className: 'bg-primary text-primary-foreground hover:bg-primary/90' }}
            >
              {route.label}
            </Link>
          ))}
        </div>
      </CardContent>
    </Card>
  );
} 