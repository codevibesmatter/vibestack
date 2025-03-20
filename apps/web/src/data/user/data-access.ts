import { User } from '@repo/dataforge/client-entities';
import { ValidatingDataAccess } from '../common/base/ValidatingDataAccess';
import { changesLogger } from '../../utils/logger';
import { DataResult, executeWithTimeout } from '../common/base/DataAccess';

export class UserDataAccess extends ValidatingDataAccess<User> {
  constructor() {
    super('user', User);
  }

  async update(id: string, data: Partial<User>): Promise<DataResult<User>> {
    changesLogger.logServiceEvent(`Starting database update for user ${id}`);
    const startTime = performance.now();
    
    try {
      // Use the executeWithTimeout function to prevent long-running queries
      const result = await executeWithTimeout(
        () => super.update(id, data),
        'update',
        'user',
        id
      );
      
      const endTime = performance.now();
      const duration = endTime - startTime;
      changesLogger.logServiceEvent(`Database update for user ${id} completed in ${duration.toFixed(2)}ms`);
      
      return result;
    } catch (error) {
      const endTime = performance.now();
      const duration = endTime - startTime;
      changesLogger.logServiceError(`Database update for user ${id} failed after ${duration.toFixed(2)}ms`, error);
      throw error;
    }
  }
} 