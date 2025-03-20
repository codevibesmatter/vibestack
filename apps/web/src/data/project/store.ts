import { atom } from 'jotai';
import { useAtom } from 'jotai';
import { atomWithReset } from 'jotai/utils';
import { atomFamily } from 'jotai/utils';
import { Project } from '@repo/dataforge/client-entities';
import { 
  getAllProjects, 
  createProject, 
  updateProject, 
  deleteProject, 
  getProjectById,
  getProjectsByOwnerId,
  getProjectsByStatus,
  searchProjectsByName
} from './api';
import { PerformanceMetrics } from '../common/base/DataAccess';
import { dbMessageBus, DbEventType } from '../../db/message-bus';
import { useEffect } from 'react';

// Extended Project type for optimistic updates
interface OptimisticProject extends Project {
  _optimistic?: boolean;
  _temp?: boolean;
}

// ===== Base atoms =====
export const projectsAtom = atom<OptimisticProject[]>([]);
export const projectsLoadingAtom = atom<boolean>(false);
export const projectsErrorAtom = atom<string | null>(null);
export const projectsTotalCountAtom = atom<number>(0);
export const projectsMetricsAtom = atom<PerformanceMetrics>({ queryTime: 0, totalTime: 0 });

// ===== Normalized store atoms =====
// Map of project IDs to project objects
export const projectsByIdAtom = atom<Record<string, OptimisticProject>>({});
// Set of project IDs that are currently loading
export const loadingProjectIdsAtom = atom<Set<string>>(new Set<string>());
// Set of project IDs that have errors
export const errorProjectIdsAtom = atom<Record<string, string>>({});
// Set of project IDs that are loaded
export const loadedProjectIdsAtom = atom<Set<string>>(new Set<string>());

// ===== UI state atoms =====
export const selectedProjectIdAtom = atomWithReset<string | null>(null);
export const highlightedProjectIdAtom = atomWithReset<string | null>(null);

// ===== Derived atoms =====
export const selectedProjectAtom = atom(
  (get) => {
    const selectedId = get(selectedProjectIdAtom);
    if (!selectedId) return null;
    
    // First check the normalized store
    const projectsById = get(projectsByIdAtom);
    if (projectsById[selectedId]) return projectsById[selectedId];
    
    // Fall back to the array if not found in normalized store
    const projects = get(projectsAtom);
    return projects.find(project => project.id === selectedId) || null;
  }
);

// Create an atom family for accessing individual projects by ID
export const projectByIdAtom = atomFamily((projectId: string) => 
  atom(
    (get) => {
      const projectsById = get(projectsByIdAtom);
      return projectsById[projectId] || null;
    }
  )
);

// ===== Filter atoms =====
export const projectFilterAtom = atom<{
  ownerId?: string;
  searchTerm?: string;
}>({});

export const filteredProjectsAtom = atom(
  (get) => {
    const projects = get(projectsAtom);
    const filter = get(projectFilterAtom);
    
    return projects.filter(project => {
      // Filter by owner ID
      if (filter.ownerId && project.ownerId !== filter.ownerId) {
        return false;
      }
      
      // Filter by search term
      if (filter.searchTerm && !project.name.toLowerCase().includes(filter.searchTerm.toLowerCase())) {
        return false;
      }
      
      return true;
    });
  }
);

// ===== Action atoms =====

// Fetch all projects
export const fetchProjectsAtom = atom(
  null,
  async (get, set) => {
    set(projectsLoadingAtom, true);
    set(projectsErrorAtom, null);
    
    try {
      const startTime = performance.now();
      
      // Get filter values
      const filter = get(projectFilterAtom);
      
      // Fetch projects from API
      const projects = await getAllProjects({
        orderBy: '"updatedAt" DESC',
        ownerId: filter.ownerId
      });
      
      // Calculate metrics
      const endTime = performance.now();
      const metrics = {
        queryTime: endTime - startTime,
        totalTime: endTime - startTime
      };
      
      // Update atoms
      set(projectsAtom, projects as OptimisticProject[]);
      set(projectsTotalCountAtom, projects.length);
      set(projectsMetricsAtom, metrics);
      
      // Update normalized store
      const projectsById: Record<string, OptimisticProject> = {};
      const loadedIds = new Set<string>();
      
      projects.forEach(project => {
        projectsById[project.id] = project as OptimisticProject;
        loadedIds.add(project.id);
      });
      
      set(projectsByIdAtom, projectsById);
      set(loadedProjectIdsAtom, loadedIds);
      
      return projects;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to fetch projects';
      set(projectsErrorAtom, errorMessage);
      throw error;
    } finally {
      set(projectsLoadingAtom, false);
    }
  }
);

// Fetch a single project by ID
export const fetchProjectByIdAtom = atom(
  null,
  async (get, set, projectId: string) => {
    // Add to loading set
    const loadingIds = new Set(get(loadingProjectIdsAtom));
    loadingIds.add(projectId);
    set(loadingProjectIdsAtom, loadingIds);
    
    // Clear any previous errors
    const errorIds = { ...get(errorProjectIdsAtom) };
    delete errorIds[projectId];
    set(errorProjectIdsAtom, errorIds);
    
    try {
      // Fetch project from API
      const project = await getProjectById(projectId);
      
      if (project) {
        // Update normalized store
        const projectsById = { ...get(projectsByIdAtom) };
        projectsById[projectId] = project;
        set(projectsByIdAtom, projectsById);
        
        // Add to loaded set
        const loadedIds = new Set(get(loadedProjectIdsAtom));
        loadedIds.add(projectId);
        set(loadedProjectIdsAtom, loadedIds);
      }
    } catch (error) {
      // Add to error set
      const errorIds = { ...get(errorProjectIdsAtom) };
      errorIds[projectId] = error instanceof Error ? error.message : String(error);
      set(errorProjectIdsAtom, errorIds);
    } finally {
      // Remove from loading set
      const loadingIds = new Set(get(loadingProjectIdsAtom));
      loadingIds.delete(projectId);
      set(loadingProjectIdsAtom, loadingIds);
    }
  }
);

// Create a project with optimistic updates
export const createProjectAtom = atom(
  null,
  async (get, set, projectData: Partial<Project>) => {
    // Generate a temporary ID for optimistic update
    const tempId = `temp-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    
    try {
      // Create optimistic project
      const now = new Date();
      const optimisticProject: OptimisticProject = {
        id: tempId,
        name: projectData.name || 'New Project',
        description: projectData.description || '',
        ownerId: projectData.ownerId || '',
        createdAt: now,
        updatedAt: now,
        _optimistic: true,
        _temp: true,
        tasks: [],
        owner: {} as any // Use empty object cast as any to satisfy the type checker
      };
      
      // Apply optimistic update to store immediately
      const projectsById = { ...get(projectsByIdAtom) };
      projectsById[tempId] = optimisticProject;
      set(projectsByIdAtom, projectsById);
      
      // Update projects array optimistically
      const projects = [optimisticProject, ...get(projectsAtom)];
      set(projectsAtom, projects);
      set(projectsTotalCountAtom, projects.length);
      
      // Add to loaded set
      const loadedIds = new Set(get(loadedProjectIdsAtom));
      loadedIds.add(tempId);
      set(loadedProjectIdsAtom, loadedIds);
      
      // Perform actual API create - returns the project ID
      const newProjectId = await createProject(projectData);
      
      // Fetch the complete project object
      const newProject = await getProjectById(newProjectId);
      
      if (!newProject) {
        throw new Error(`Failed to fetch newly created project with ID ${newProjectId}`);
      }
      
      // Remove temporary project
      const updatedProjectsById = { ...get(projectsByIdAtom) };
      delete updatedProjectsById[tempId];
      updatedProjectsById[newProjectId] = newProject as OptimisticProject;
      set(projectsByIdAtom, updatedProjectsById);
      
      // Update projects array with real project
      const updatedProjects = get(projectsAtom)
        .filter(project => !project._temp)
        .concat([newProject as OptimisticProject])
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
      set(projectsAtom, updatedProjects);
      
      // Update loaded IDs
      const updatedLoadedIds = new Set(get(loadedProjectIdsAtom));
      updatedLoadedIds.delete(tempId);
      updatedLoadedIds.add(newProjectId);
      set(loadedProjectIdsAtom, updatedLoadedIds);
      
      return newProject;
    } catch (error: unknown) {
      // Revert optimistic create on failure
      const projectsById = { ...get(projectsByIdAtom) };
      delete projectsById[tempId];
      set(projectsByIdAtom, projectsById);
      
      // Update projects array
      const projects = get(projectsAtom).filter(project => project.id !== tempId);
      set(projectsAtom, projects);
      set(projectsTotalCountAtom, projects.length);
      
      // Remove from loaded set
      const loadedIds = new Set(get(loadedProjectIdsAtom));
      loadedIds.delete(tempId);
      set(loadedProjectIdsAtom, loadedIds);
      
      throw error;
    }
  }
);

// Update a project with optimistic updates
export const updateProjectAtom = atom(
  null,
  async (get, set, projectId: string, projectData: Partial<Project>) => {
    try {
      // Get current project data
      const currentProject = get(projectsByIdAtom)[projectId];
      if (!currentProject) {
        throw new Error(`Project with ID ${projectId} not found in store`);
      }
      
      // Create optimistic update with current timestamp
      const now = new Date();
      const optimisticProject: OptimisticProject = {
        ...currentProject,
        ...projectData,
        updatedAt: now,
        _optimistic: true // Mark as optimistic
      };
      
      // Apply optimistic update to store immediately
      const projectsById = { ...get(projectsByIdAtom) };
      projectsById[projectId] = optimisticProject;
      set(projectsByIdAtom, projectsById);
      
      // Update projects array optimistically
      const projects = get(projectsAtom).map(project => 
        project.id === projectId ? optimisticProject : project
      );
      set(projectsAtom, projects);
      
      // Perform actual API update
      const updatedProject = await updateProject(projectId, projectData);
      
      // Confirm update with actual data from API
      const confirmedProject: OptimisticProject = {
        ...updatedProject,
        _optimistic: false
      };
      
      // Update normalized store with confirmed data
      const confirmedProjectsById = { ...get(projectsByIdAtom) };
      confirmedProjectsById[projectId] = confirmedProject;
      set(projectsByIdAtom, confirmedProjectsById);
      
      // Update projects array with confirmed data
      const confirmedProjects = get(projectsAtom).map(project => 
        project.id === projectId ? confirmedProject : project
      );
      set(projectsAtom, confirmedProjects);
      
      return updatedProject;
    } catch (error: unknown) {
      // Revert optimistic update on failure
      if (get(projectsByIdAtom)[projectId]?._optimistic) {
        // Fetch the original data to revert
        try {
          const originalProject = await getProjectById(projectId);
          
          if (originalProject) {
            // Revert in normalized store
            const projectsById = { ...get(projectsByIdAtom) };
            projectsById[projectId] = originalProject as OptimisticProject;
            set(projectsByIdAtom, projectsById);
            
            // Revert in projects array
            const projects = get(projectsAtom).map(project => 
              project.id === projectId ? (originalProject as OptimisticProject) : project
            );
            set(projectsAtom, projects);
          }
        } catch (fetchError) {
          console.error('Error fetching original project data for revert:', fetchError);
        }
      }
      
      throw error;
    }
  }
);

// Delete a project with optimistic updates
export const deleteProjectAtom = atom(
  null,
  async (get, set, projectId: string) => {
    try {
      // Get current project data
      const currentProject = get(projectsByIdAtom)[projectId];
      if (!currentProject) {
        throw new Error(`Project with ID ${projectId} not found in store`);
      }
      
      // Store the current project for potential revert
      const projectToDelete = { ...currentProject };
      
      // Apply optimistic delete to store immediately
      const projectsById = { ...get(projectsByIdAtom) };
      delete projectsById[projectId];
      set(projectsByIdAtom, projectsById);
      
      // Update projects array optimistically
      const projects = get(projectsAtom).filter(project => project.id !== projectId);
      set(projectsAtom, projects);
      set(projectsTotalCountAtom, projects.length);
      
      // Remove from loaded set
      const loadedIds = new Set(get(loadedProjectIdsAtom));
      loadedIds.delete(projectId);
      set(loadedProjectIdsAtom, loadedIds);
      
      // Perform actual API delete
      await deleteProject(projectId);
      
      return projectToDelete;
    } catch (error: unknown) {
      // Revert optimistic delete on failure
      try {
        const originalProject = await getProjectById(projectId);
        
        if (originalProject) {
          // Restore in normalized store
          const projectsById = { ...get(projectsByIdAtom) };
          projectsById[projectId] = originalProject as OptimisticProject;
          set(projectsByIdAtom, projectsById);
          
          // Restore in projects array
          const projects = [...get(projectsAtom), originalProject as OptimisticProject]
            .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
          set(projectsAtom, projects);
          set(projectsTotalCountAtom, projects.length);
          
          // Add back to loaded set
          const loadedIds = new Set(get(loadedProjectIdsAtom));
          loadedIds.add(projectId);
          set(loadedProjectIdsAtom, loadedIds);
        }
      } catch (fetchError) {
        console.error('Error fetching original project data for revert:', fetchError);
      }
      
      throw error;
    }
  }
);

// Hook for subscribing to project changes
export function useProjectChanges() {
  const [, fetchProjects] = useAtom(fetchProjectsAtom);
  const [, fetchProjectById] = useAtom(fetchProjectByIdAtom);
  const [loadedIds] = useAtom(loadedProjectIdsAtom);
  
  useEffect(() => {
    const handleProjectChange = (data: any) => {
      if (data.table === 'project' || data.entity === 'project') {
        const changeType = data.type || data.operation;
        if (changeType === 'insert' || changeType === 'update') {
          // If we already have this project loaded, refresh it
          const projectId = data.id || data.entityId;
          if (loadedIds.has(projectId)) {
            fetchProjectById(projectId);
          } else {
            // Otherwise refresh the whole list
            fetchProjects();
          }
        } else if (changeType === 'delete') {
          // Always refresh the list on delete
          fetchProjects();
        }
      }
    };
    
    // Subscribe to entity updates and changes
    const unsubscribe1 = dbMessageBus.subscribe('entity_updated' as DbEventType, handleProjectChange);
    const unsubscribe2 = dbMessageBus.subscribe('entity_deleted' as DbEventType, handleProjectChange);
    const unsubscribe3 = dbMessageBus.subscribe('change_processed' as DbEventType, handleProjectChange);
    
    return () => {
      unsubscribe1();
      unsubscribe2();
      unsubscribe3();
    };
  }, [fetchProjects, fetchProjectById, loadedIds]);
}

// No-op subscription atom for database changes
// This is kept for backward compatibility but doesn't do anything now
export const projectDbSubscriptionAtom = atom(
  null,
  (get, set, subscribe: boolean) => {
    console.log('Project DB subscription atom is now a no-op with optimistic updates');
    return () => {
      // No-op cleanup
      console.log('Project DB subscription cleanup is now a no-op');
    };
  }
);

// ===== Helper hook for using the subscription =====
// This is now a no-op function since we're handling updates directly in the store
export const useProjectDbSubscription = () => {
  useEffect(() => {
    // This function is now a no-op since we're using optimistic updates
    console.log('Project DB subscription is now a no-op with optimistic updates');
    return () => {
      // No-op cleanup
    };
  }, []);
}; 