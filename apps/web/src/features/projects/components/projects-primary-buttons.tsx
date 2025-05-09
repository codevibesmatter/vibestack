import React from 'react';
import { Button } from '@/components/ui/button';
import { Plus } from 'lucide-react';
import { useProjects } from '../context/projects-context';

export function ProjectsPrimaryButtons() {
  const { setIsCreateDrawerOpen } = useProjects();

  return (
    <div className='flex flex-wrap items-center gap-2'>
      <Button onClick={() => setIsCreateDrawerOpen(true)}>
        <Plus className='mr-2 h-4 w-4' />
        New Project
      </Button>
    </div>
  );
} 