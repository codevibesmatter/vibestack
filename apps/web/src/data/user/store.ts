import { atom } from 'jotai';
import { useAtom } from 'jotai';
import { atomWithReset } from 'jotai/utils';
import { atomFamily } from 'jotai/utils';
import { User } from '@repo/typeorm/client-entities';
import { getAllUsers, createUser, updateUser, deleteUser, getUserById } from './api';
import { DataResult, PerformanceMetrics } from '../common/base/DataAccess';
import { dbMessageBus, DbEventType } from '../../db/message-bus';
import { useEffect } from 'react';

// Extended User type for optimistic updates
interface OptimisticUser extends User {
  _optimistic?: boolean;
  _temp?: boolean;
}

// ===== Base atoms =====
export const usersAtom = atom<OptimisticUser[]>([]);
export const usersLoadingAtom = atom<boolean>(false);
export const usersErrorAtom = atom<string | null>(null);
export const usersTotalCountAtom = atom<number>(0);
export const usersMetricsAtom = atom<PerformanceMetrics>({ queryTime: 0, totalTime: 0 });

// ===== Normalized store atoms =====
// Map of user IDs to user objects
export const usersByIdAtom = atom<Record<string, OptimisticUser>>({});
// Set of user IDs that are currently loading
export const loadingUserIdsAtom = atom<Set<string>>(new Set<string>());
// Set of user IDs that have errors
export const errorUserIdsAtom = atom<Record<string, string>>({});
// Set of user IDs that are loaded
export const loadedUserIdsAtom = atom<Set<string>>(new Set<string>());

// ===== UI state atoms =====
export const selectedUserIdAtom = atomWithReset<string | null>(null);
export const highlightedUserIdAtom = atomWithReset<string | null>(null);

// ===== Derived atoms =====
export const selectedUserAtom = atom(
  (get) => {
    const selectedId = get(selectedUserIdAtom);
    if (!selectedId) return null;
    
    // First check the normalized store
    const usersById = get(usersByIdAtom);
    if (usersById[selectedId]) return usersById[selectedId];
    
    // Fall back to the array if not found in normalized store
    const users = get(usersAtom);
    return users.find(user => user.id === selectedId) || null;
  }
);

// Create an atom family for accessing individual users by ID
export const userByIdAtom = atomFamily((userId: string) => 
  atom(
    (get) => {
      const usersById = get(usersByIdAtom);
      return usersById[userId] || null;
    }
  )
);

// ===== Fetch atoms =====
export const fetchUsersAtom = atom(
  null,
  async (get, set) => {
    set(usersLoadingAtom, true);
    set(usersErrorAtom, null);
    
    try {
      const users = await getAllUsers();
      
      // Update normalized store
      const usersById: Record<string, OptimisticUser> = {};
      const loadedIds = new Set<string>();
      
      users.forEach(user => {
        usersById[user.id] = user as OptimisticUser;
        loadedIds.add(user.id);
      });
      
      set(usersByIdAtom, usersById);
      set(loadedUserIdsAtom, loadedIds);
      
      // Update users array
      set(usersAtom, users as OptimisticUser[]);
      set(usersTotalCountAtom, users.length);
      
      return users;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to fetch users';
      set(usersErrorAtom, errorMessage);
      throw error;
    } finally {
      set(usersLoadingAtom, false);
    }
  }
);

// ===== Fetch by ID atom =====
export const fetchUserByIdAtom = atom(
  null,
  async (get, set, userId: string) => {
    // Check if already loaded
    if (get(loadedUserIdsAtom).has(userId)) {
      return get(usersByIdAtom)[userId];
    }
    
    // Mark as loading
    const loadingIds = new Set(get(loadingUserIdsAtom));
    loadingIds.add(userId);
    set(loadingUserIdsAtom, loadingIds);
    
    try {
      const user = await getUserById(userId);
      
      if (!user) {
        throw new Error(`User with ID ${userId} not found`);
      }
      
      // Update normalized store
      const usersById = { ...get(usersByIdAtom) };
      usersById[userId] = user as OptimisticUser;
      set(usersByIdAtom, usersById);
      
      // Add to loaded set
      const loadedIds = new Set(get(loadedUserIdsAtom));
      loadedIds.add(userId);
      set(loadedUserIdsAtom, loadedIds);
      
      return user;
    } catch (error: unknown) {
      // Record error
      const errors = { ...get(errorUserIdsAtom) };
      errors[userId] = error instanceof Error ? error.message : 'Failed to fetch user';
      set(errorUserIdsAtom, errors);
      
      throw error;
    } finally {
      // Remove from loading set
      const loadingIds = new Set(get(loadingUserIdsAtom));
      loadingIds.delete(userId);
      set(loadingUserIdsAtom, loadingIds);
    }
  }
);

// Create a new user with optimistic updates
export const createUserAtom = atom(
  null,
  async (get, set, userData: Partial<User>) => {
    // Generate a temporary ID for optimistic update
    const tempId = `temp-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    
    try {
      // Create optimistic user
      const now = new Date();
      const optimisticUser: OptimisticUser = {
        id: tempId,
        name: userData.name || 'New User',
        email: userData.email || `${tempId}@example.com`,
        avatarUrl: userData.avatarUrl || undefined,
        createdAt: now,
        updatedAt: now,
        _optimistic: true,
        _temp: true,
        tasks: [],
        projects: []
      };
      
      // Apply optimistic update to store immediately
      const usersById = { ...get(usersByIdAtom) };
      usersById[tempId] = optimisticUser;
      set(usersByIdAtom, usersById);
      
      // Update users array optimistically
      const users = [optimisticUser, ...get(usersAtom)];
      set(usersAtom, users);
      set(usersTotalCountAtom, users.length);
      
      // Add to loaded set
      const loadedIds = new Set(get(loadedUserIdsAtom));
      loadedIds.add(tempId);
      set(loadedUserIdsAtom, loadedIds);
      
      // Perform actual API create
      const newUser = await createUser(userData);
      
      // Remove temporary user
      const updatedUsersById = { ...get(usersByIdAtom) };
      delete updatedUsersById[tempId];
      updatedUsersById[newUser.id] = newUser as OptimisticUser;
      set(usersByIdAtom, updatedUsersById);
      
      // Update users array with real user
      const updatedUsers = get(usersAtom)
        .filter(user => !user._temp)
        .concat([newUser as OptimisticUser])
        .sort((a, b) => a.name.localeCompare(b.name));
      set(usersAtom, updatedUsers);
      
      // Update loaded IDs
      const updatedLoadedIds = new Set(get(loadedUserIdsAtom));
      updatedLoadedIds.delete(tempId);
      updatedLoadedIds.add(newUser.id);
      set(loadedUserIdsAtom, updatedLoadedIds);
      
      return newUser;
    } catch (error) {
      // Revert optimistic create on failure
      const usersById = { ...get(usersByIdAtom) };
      delete usersById[tempId];
      set(usersByIdAtom, usersById);
      
      // Update users array
      const users = get(usersAtom).filter(user => user.id !== tempId);
      set(usersAtom, users);
      set(usersTotalCountAtom, users.length);
      
      // Remove from loaded set
      const loadedIds = new Set(get(loadedUserIdsAtom));
      loadedIds.delete(tempId);
      set(loadedUserIdsAtom, loadedIds);
      
      throw error;
    }
  }
);

// Update a user with optimistic updates
export const updateUserAtom = atom(
  null,
  async (get, set, userId: string, userData: Partial<User>) => {
    try {
      // Get current user data
      const currentUser = get(usersByIdAtom)[userId];
      if (!currentUser) {
        throw new Error(`User with ID ${userId} not found in store`);
      }
      
      // Create optimistic update with current timestamp
      const now = new Date();
      const optimisticUser: OptimisticUser = {
        ...currentUser,
        ...userData,
        updatedAt: now,
        _optimistic: true // Mark as optimistic
      };
      
      // Apply optimistic update to store immediately
      const usersById = { ...get(usersByIdAtom) };
      usersById[userId] = optimisticUser;
      set(usersByIdAtom, usersById);
      
      // Update users array optimistically
      const users = get(usersAtom).map(user => 
        user.id === userId ? optimisticUser : user
      );
      set(usersAtom, users);
      
      // Perform actual API update
      const updatedUser = await updateUser(userId, userData);
      
      // Confirm update with actual data from API
      const confirmedUser: OptimisticUser = {
        ...updatedUser,
        _optimistic: false
      };
      
      // Update normalized store with confirmed data
      const confirmedUsersById = { ...get(usersByIdAtom) };
      confirmedUsersById[userId] = confirmedUser;
      set(usersByIdAtom, confirmedUsersById);
      
      // Update users array with confirmed data
      const confirmedUsers = get(usersAtom).map(user => 
        user.id === userId ? confirmedUser : user
      );
      set(usersAtom, confirmedUsers);
      
      return updatedUser;
    } catch (error: unknown) {
      // Revert optimistic update on failure
      if (get(usersByIdAtom)[userId]?._optimistic) {
        // Fetch the original data to revert
        try {
          const originalUser = await getUserById(userId);
          
          if (originalUser) {
            // Revert in normalized store
            const usersById = { ...get(usersByIdAtom) };
            usersById[userId] = originalUser as OptimisticUser;
            set(usersByIdAtom, usersById);
            
            // Revert in users array
            const users = get(usersAtom).map(user => 
              user.id === userId ? (originalUser as OptimisticUser) : user
            );
            set(usersAtom, users);
          }
        } catch (fetchError) {
          console.error('Error fetching original user data for revert:', fetchError);
        }
      }
      
      throw error;
    }
  }
);

// Delete a user with optimistic updates
export const deleteUserAtom = atom(
  null,
  async (get, set, userId: string) => {
    try {
      // Get current user data for potential revert
      const currentUser = get(usersByIdAtom)[userId];
      if (!currentUser) {
        throw new Error(`User with ID ${userId} not found in store`);
      }
      
      // Apply optimistic delete to store immediately
      const usersById = { ...get(usersByIdAtom) };
      delete usersById[userId];
      set(usersByIdAtom, usersById);
      
      // Update users array optimistically
      const users = get(usersAtom).filter(user => user.id !== userId);
      set(usersAtom, users);
      set(usersTotalCountAtom, users.length);
      
      // Remove from loaded set
      const loadedIds = new Set(get(loadedUserIdsAtom));
      loadedIds.delete(userId);
      set(loadedUserIdsAtom, loadedIds);
      
      // Perform actual API delete
      const deletedUser = await deleteUser(userId);
      
      return deletedUser;
    } catch (error) {
      // Revert optimistic delete on failure
      if (!get(usersByIdAtom)[userId]) {
        try {
          const originalUser = await getUserById(userId);
          
          if (originalUser) {
            // Restore in normalized store
            const usersById = { ...get(usersByIdAtom) };
            usersById[userId] = originalUser as OptimisticUser;
            set(usersByIdAtom, usersById);
            
            // Restore in users array
            const users = [...get(usersAtom), originalUser].sort((a, b) => 
              a.name.localeCompare(b.name)
            );
            set(usersAtom, users);
            set(usersTotalCountAtom, users.length);
            
            // Restore to loaded set
            const loadedIds = new Set(get(loadedUserIdsAtom));
            loadedIds.add(userId);
            set(loadedUserIdsAtom, loadedIds);
          }
        } catch (fetchError) {
          console.error('Error fetching original user data for revert:', fetchError);
        }
      }
      
      throw error;
    }
  }
);

// Hook for subscribing to user changes
export function useUserChanges() {
  const [, fetchUsers] = useAtom(fetchUsersAtom);
  const [, fetchUserById] = useAtom(fetchUserByIdAtom);
  const [loadedIds] = useAtom(loadedUserIdsAtom);
  
  useEffect(() => {
    const handleUserChange = (data: any) => {
      if (data.table === 'user' || data.entity === 'user') {
        const changeType = data.type || data.operation;
        if (changeType === 'insert' || changeType === 'update') {
          // If we already have this user loaded, refresh it
          const userId = data.id || data.entityId;
          if (loadedIds.has(userId)) {
            fetchUserById(userId);
          } else {
            // Otherwise refresh the whole list
            fetchUsers();
          }
        } else if (changeType === 'delete') {
          // Always refresh the list on delete
          fetchUsers();
        }
      }
    };
    
    // Subscribe to entity updates and changes
    const unsubscribe1 = dbMessageBus.subscribe('entity_updated' as DbEventType, handleUserChange);
    const unsubscribe2 = dbMessageBus.subscribe('entity_deleted' as DbEventType, handleUserChange);
    const unsubscribe3 = dbMessageBus.subscribe('change_processed' as DbEventType, handleUserChange);
    
    return () => {
      unsubscribe1();
      unsubscribe2();
      unsubscribe3();
    };
  }, [fetchUsers, fetchUserById, loadedIds]);
}

// No-op subscription atom for database changes
// This is kept for backward compatibility but doesn't do anything now
export const userDbSubscriptionAtom = atom(
  null,
  (get, set, subscribe: boolean) => {
    console.log('User DB subscription atom is now a no-op with optimistic updates');
    return () => {
      // No-op cleanup
      console.log('User DB subscription cleanup is now a no-op');
    };
  }
);

// ===== Helper hook for using the subscription =====
// This is now a no-op function since we're handling updates directly in the store
export const useUserDbSubscription = () => {
  useEffect(() => {
    // This function is now a no-op since we're using optimistic updates
    console.log('User DB subscription is now a no-op with optimistic updates');
    return () => {
      // No-op cleanup
    };
  }, []);
}; 