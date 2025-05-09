import React from 'react';
import { Project } from '@repo/dataforge/client-entities';
import { ProjectCard } from './project-card';
import { TooltipProvider } from '@/components/ui/tooltip';
import { FolderPlus } from 'lucide-react';
import { useProjects } from '../context/projects-context';

interface ProjectGridProps {
  projects: Project[];
}

export function ProjectGrid({ projects }: ProjectGridProps) {
  const { setIsCreateDrawerOpen } = useProjects();

  if (projects.length === 0) {
    return (
      <TooltipProvider>
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <FolderPlus className="h-16 w-16 text-muted-foreground mb-4" />
          <h3 className="text-xl font-semibold mb-2">No projects yet</h3>
          <p className="text-muted-foreground">Create your first project to get started</p>
        </div>
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {projects.map((project) => (
          <ProjectCard key={project.id} project={project} />
        ))}
      </div>
    </TooltipProvider>
  );
} 