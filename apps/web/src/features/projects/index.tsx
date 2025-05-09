import React, { useEffect, useState } from 'react';
import { Main } from '@/components/layout/main';
import { Header } from '@/components/layout/header';
import { Search } from '@/components/search';
import { ThemeSwitch } from '@/components/theme-switch';
import { ProfileDropdown } from '@/components/profile-dropdown';
import ProjectsProvider from './context/projects-context';
import { ProjectGrid } from './components/project-grid';
import { ProjectsDialogs } from './components/projects-dialogs';
import { ProjectsPrimaryButtons } from './components/projects-primary-buttons';
import { usePGliteContext } from '@/db/pglite-provider';
import { Project } from '@repo/dataforge/client-entities';

/**
 * Main Projects Feature Component
 * Displays projects as cards in a grid layout with real-time updates
 */
const Projects: React.FC = () => {
  const [projects, setProjects] = useState<Project[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [refreshCounter, setRefreshCounter] = useState(0);
  const { services } = usePGliteContext();

  // Load projects directly from the service
  useEffect(() => {
    let mounted = true;
    
    const loadProjects = async () => {
      if (!services?.projects) return;
      
      try {
        setIsLoading(true);
        console.log('[Projects Component] Fetching projects...');
        const data = await services.projects.getAll();
        
        if (mounted) {
          console.log('[Projects Component] Projects loaded:', data?.length || 0);
          console.log('[Projects Component] Project data structure:', JSON.stringify(data, null, 2));
          setProjects(data || []);
          setIsLoading(false);
        }
      } catch (err) {
        console.error('[Projects Component] Error loading projects:', err);
        if (mounted) {
          setError(err instanceof Error ? err : new Error(String(err)));
          setIsLoading(false);
        }
      }
    };
    
    loadProjects();
    
    // Set up a listener for the project events
    const handleProjectUpdated = (event: any) => {
      console.log('[Projects Component] Project updated event received:', event.detail);
      // Refresh the projects list
      loadProjects();
    };
    
    const handleProjectCreated = (event: any) => {
      console.log('[Projects Component] Project created event received:', event.detail);
      // Refresh the projects list
      loadProjects();
    };
    
    const handleProjectDeleted = (event: any) => {
      console.log('[Projects Component] Project deleted event received:', event.detail);
      // Refresh the projects list
      loadProjects();
    };
    
    // Also listen for other relevant events
    const handleSyncComplete = () => {
      console.log('[Projects Component] Sync completed, refreshing projects...');
      loadProjects();
    };
    
    window.addEventListener('project-updated', handleProjectUpdated);
    window.addEventListener('project-created', handleProjectCreated);
    window.addEventListener('project-deleted', handleProjectDeleted);
    window.addEventListener('sync-complete', handleSyncComplete);
    
    return () => {
      mounted = false;
      window.removeEventListener('project-updated', handleProjectUpdated);
      window.removeEventListener('project-created', handleProjectCreated);
      window.removeEventListener('project-deleted', handleProjectDeleted);
      window.removeEventListener('sync-complete', handleSyncComplete);
    };
  }, [services]);

  return (
    <ProjectsProvider>
      <Header fixed>
        <Search />
        <div className='ml-auto flex items-center space-x-4'>
          <ThemeSwitch />
          <ProfileDropdown />
        </div>
      </Header>

      <Main>
        <div className='mb-4 flex flex-wrap items-center justify-between space-y-2 gap-x-4'>
          <div>
            <h2 className='text-2xl font-bold tracking-tight'>Projects</h2>
            <p className='text-muted-foreground'>
              Manage your projects and track their progress
            </p>
          </div>
          <ProjectsPrimaryButtons />
        </div>
        <div className='py-1'>
          {isLoading && <p>Loading projects...</p>}
          {error && <p className="text-destructive">Error loading projects: {error.message}</p>}
          {!isLoading && !error && (
            <ProjectGrid projects={projects || []} />
          )}
        </div>
      </Main>

      <ProjectsDialogs />
    </ProjectsProvider>
  );
};

export default Projects; 