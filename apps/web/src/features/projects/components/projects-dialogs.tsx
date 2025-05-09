import React, { useState } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { ProjectsMutateDrawer } from './projects-mutate-drawer';
import { useProjects } from '../context/projects-context';

export function ProjectsDialogs() {
  const [isDeleting, setIsDeleting] = useState(false);
  
  const { 
    selectedProject, 
    isCreateDrawerOpen, 
    setIsCreateDrawerOpen,
    isUpdateDrawerOpen, 
    setIsUpdateDrawerOpen,
    isDeleteDialogOpen, 
    setIsDeleteDialogOpen,
    deleteProject
  } = useProjects();

  const handleDeleteConfirm = async () => {
    if (!selectedProject) return;
    
    setIsDeleting(true);
    try {
      await deleteProject(selectedProject.id);
      setIsDeleteDialogOpen(false);
    } catch (error) {
      console.error('Error deleting project:', error);
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <>
      {/* Create Drawer */}
      <ProjectsMutateDrawer
        open={isCreateDrawerOpen}
        onOpenChange={setIsCreateDrawerOpen}
      />

      {/* Update Drawer */}
      {selectedProject && (
        <ProjectsMutateDrawer
          open={isUpdateDrawerOpen}
          onOpenChange={setIsUpdateDrawerOpen}
          currentProject={selectedProject}
        />
      )}

      {/* Delete Confirmation Dialog */}
      <AlertDialog 
        open={isDeleteDialogOpen} 
        onOpenChange={setIsDeleteDialogOpen}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Are you sure?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the project 
              {selectedProject ? ` "${selectedProject.name}"` : ''} 
              and all of its data.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction 
              onClick={handleDeleteConfirm}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? 'Deleting...' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
} 