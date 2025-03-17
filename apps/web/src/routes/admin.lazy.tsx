import React, { useState, useEffect } from 'react';
import { createLazyFileRoute } from '@tanstack/react-router';
import { AdminPanel } from '../components/AdminPanel';
import { getDatabase } from '../db/core';
import type { PGlite } from '@electric-sql/pglite';
import { LoadingScreen } from '../components/LoadingScreen';

function AdminPage() {
  const [db, setDb] = useState<PGlite | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function initDb() {
      try {
        setIsLoading(true);
        const dbInstance = await getDatabase();
        
        // Cast to PGlite to match the AdminPanel prop type
        setDb(dbInstance as unknown as PGlite);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to get database instance');
      } finally {
        setIsLoading(false);
      }
    }

    initDb();
  }, []);

  if (isLoading) {
    return <LoadingScreen message="Loading database..." />;
  }

  if (error || !db) {
    return (
      <div className="container mx-auto px-4 py-8 text-red-500">
        <h1 className="text-3xl font-bold mb-4">Error</h1>
        <p>{error || 'Failed to get database instance'}</p>
      </div>
    );
  }
  
  return (
    <div className="container mx-auto px-4 py-8">
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-white">Admin Panel</h1>
        <p className="text-gray-400 mt-2">Database management and system configuration</p>
      </div>
      <AdminPanel db={db} />
    </div>
  );
}

export const Route = createLazyFileRoute('/admin')({
  component: AdminPage
}) 