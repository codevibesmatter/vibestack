import React from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardAction, CardFooter } from '@/components/ui/card'; // Added CardFooter
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { CheckSquare, Edit2, Trash2 } from 'lucide-react';
import { Project, ProjectStatus } from '@repo/dataforge/client-entities';
import { useProjects } from '../context/projects-context';

interface ProjectCardProps {
  project: Project;
}

export function ProjectCard({ project }: ProjectCardProps) {
  const { 
    setSelectedProject,
    setIsUpdateDrawerOpen,
    setIsDeleteDialogOpen 
  } = useProjects();

  const handleEditClick = () => {
    setSelectedProject(project);
    setIsUpdateDrawerOpen(true);
  };

  const handleDeleteClick = () => {
    setSelectedProject(project);
    setIsDeleteDialogOpen(true);
  };

  // Format status for display
  const formatStatus = (status: string | ProjectStatus) => {
    const statusStr = String(status);
    if (!statusStr || typeof statusStr !== 'string') {
      return 'Unknown Status';
    }
    return statusStr
      .replace(/_/g, ' ')
      .replace(/\b\w/g, l => l.toUpperCase());
  };

  // Estimate line height for title (e.g., text-xl font-bold)
  // Tailwind's text-xl has a line-height of 1.75rem (28px). Two lines = 3.5rem (56px).
  // We'll use h-14 for height which is 3.5rem.
  const titleMinHeight = "h-14"; // For 2 lines of text-xl

  return (
    <Card className="overflow-hidden shadow-md hover:shadow-lg transition-shadow flex flex-col">
      <CardHeader className="p-4 relative"> {/* Changed padding to p-4, removed pb-2 */}
        {/* Actions positioned absolutely */}
        <CardAction className="absolute top-4 right-4 flex space-x-1"> {/* Adjusted top/right to match new padding */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" onClick={handleEditClick}>
                <Edit2 className="h-4 w-4" />
                <span className="sr-only">Edit Project</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent><p>Edit</p></TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="destructive" size="icon" onClick={handleDeleteClick}>
                <Trash2 className="h-4 w-4" />
                <span className="sr-only">Delete Project</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent><p>Delete</p></TooltipContent>
          </Tooltip>
        </CardAction>
        
        {/* Title - fixed height for 2 lines, with padding to avoid actions */}
        <CardTitle className={`text-xl font-bold line-clamp-2 pr-16 ${titleMinHeight}`}> {/* Adjusted pr-16 for tighter spacing with p-4 overall */}
          {project.name}
        </CardTitle>
      </CardHeader>

      {/* Description - takes up remaining space */}
      <CardContent className="px-4 pt-0 pb-2 flex-grow"> {/* Adjusted padding: px-4, pt-0, pb-2 */}
        <CardDescription> {/* Removed line-clamp-2 to allow full text */}
          {project.description || "No description"}
        </CardDescription>
      </CardContent>

      {/* Footer for Status Badge and Tasks */}
      <CardFooter className="px-4 pt-2 pb-4 flex justify-between items-center"> {/* Adjusted padding: px-4, pt-2, pb-4 */}
        <Badge>
          {formatStatus(project.status)}
        </Badge>
        <div className="flex items-center text-sm">
          <CheckSquare className="h-4 w-4 mr-1" />
          <span>0 Tasks</span>
        </div>
      </CardFooter>
    </Card>
  );
}