import { useState, useEffect } from 'react';
import { getNewPGliteDataSource } from '@/db/newtypeorm/NewDataSource';
import { useAuthStore } from '@/stores/authStore';
import { User } from '@repo/dataforge/client-entities';

export type CurrentUserState = {
  data: User | null;
  loading: boolean;
  error: Error | null;
};

/**
 * Custom hook to fetch the authenticated user's full profile from the local database
 * 
 * @returns {CurrentUserState} The user data, loading state, and any error
 */
export function useCurrentUser(): CurrentUserState {
  const { user: authUser, isAuthenticated } = useAuthStore();
  const [state, setState] = useState<CurrentUserState>({
    data: null,
    loading: isAuthenticated, // Only start loading if authenticated
    error: null
  });

  useEffect(() => {
    if (!isAuthenticated || !authUser?.id) {
      setState({
        data: null,
        loading: false,
        error: null
      });
      return;
    }

    const fetchUserProfile = async () => {
      try {
        console.log('[useCurrentUser] Fetching user profile for ID:', authUser.id);
        setState(prev => ({ ...prev, loading: true, error: null }));
        
        // Get the TypeORM data source
        const dataSource = await getNewPGliteDataSource();
        
        // Get the user repository - use the actual table name from database
        const userRepo = dataSource.getRepository<User>('users');
        
        // Find the user by ID
        const user = await userRepo.findOne({
          where: { id: authUser.id }
        });
        
        console.log('[useCurrentUser] User profile found:', user);
        
        setState({
          data: user as User,
          loading: false,
          error: null
        });
      } catch (error) {
        console.error('[useCurrentUser] Error fetching user profile:', error);
        setState({
          data: null,
          loading: false,
          error: error instanceof Error ? error : new Error(String(error))
        });
      }
    };

    fetchUserProfile();
  }, [isAuthenticated, authUser?.id]);

  return state;
} 