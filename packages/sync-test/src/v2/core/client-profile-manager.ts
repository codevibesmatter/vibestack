import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { LSN_STATE } from '../config.ts';
import { createLogger } from './logger.ts';
import * as dbService from './db-service.ts';

/**
 * Client profile interface
 */
export interface ClientProfile {
  id: string;         // UUID for this client - this is also used as the client ID
  name: string;       // Human-readable name
  profileId: number;  // Numeric profile ID (1, 2, 3...)
  lsn: string;        // Last known LSN for this client
  timestamp: number;  // Last updated timestamp
  testHistory: {      // History of tests run with this profile
    initial: number;
    liveSync: number;
    catchup: number;
  };
  // Removed activeClientId field - we'll use the profile ID directly
}

/**
 * Manages client profiles for sync tests
 */
export class ClientProfileManager {
  private logger = createLogger('ProfileMgr');
  private profiles: Map<number, ClientProfile> = new Map();
  private profilesPath: string;
  
  constructor() {
    // Store profiles in the same directory as LSN state
    this.profilesPath = path.join(
      path.dirname(LSN_STATE.FILE_PATH), 
      'client-profiles.json'
    );
    this.loadProfiles();
  }
  
  /**
   * Load client profiles from disk
   */
  private loadProfiles(): void {
    try {
      if (fs.existsSync(this.profilesPath)) {
        const data = JSON.parse(fs.readFileSync(this.profilesPath, 'utf8'));
        if (Array.isArray(data)) {
          data.forEach(profile => {
            if (this.isValidProfile(profile)) {
              this.profiles.set(profile.profileId, profile);
            }
          });
        }
        this.logger.info(`Loaded ${this.profiles.size} client profiles`);
      } else {
        this.logger.info('No client profiles found, will create when needed');
      }
    } catch (err) {
      this.logger.error(`Failed to load client profiles: ${err}`);
    }
  }
  
  /**
   * Save client profiles to disk
   */
  private saveProfiles(): void {
    try {
      fs.writeFileSync(
        this.profilesPath, 
        JSON.stringify(Array.from(this.profiles.values()), null, 2)
      );
    } catch (err) {
      this.logger.error(`Failed to save client profiles: ${err}`);
    }
  }
  
  /**
   * Validate a client profile object
   */
  private isValidProfile(profile: any): profile is ClientProfile {
    return (
      profile &&
      typeof profile.id === 'string' &&
      typeof profile.name === 'string' &&
      typeof profile.profileId === 'number' &&
      typeof profile.lsn === 'string' &&
      typeof profile.timestamp === 'number' &&
      typeof profile.testHistory === 'object' &&
      typeof profile.testHistory.initial === 'number' &&
      typeof profile.testHistory.liveSync === 'number' &&
      typeof profile.testHistory.catchup === 'number'
    );
  }
  
  /**
   * Create a new client profile
   */
  private async createProfile(profileId: number, name: string): Promise<ClientProfile> {
    // Get current server LSN instead of using 0/0
    let lsn = '0/0';
    try {
      lsn = await dbService.getCurrentLSN();
      this.logger.info(`Using current server LSN for new profile: ${lsn}`);
    } catch (error) {
      this.logger.error(`Failed to get current server LSN, using 0/0: ${error}`);
    }
    
    const profile: ClientProfile = {
      id: uuidv4(),
      name,
      profileId,
      lsn,
      timestamp: Date.now(),
      testHistory: {
        initial: 0,
        liveSync: 0,
        catchup: 0
      }
    };
    
    this.profiles.set(profileId, profile);
    this.saveProfiles();
    this.logger.info(`Created new client profile: ${name} (ID: ${profileId}) with LSN: ${lsn}`);
    return profile;
  }
  
  /**
   * Get a client profile by ID, creating if it doesn't exist
   */
  public async getProfile(profileId: number = 1): Promise<ClientProfile> {
    if (!this.profiles.has(profileId)) {
      return await this.createProfile(profileId, `Client ${profileId}`);
    }
    return this.profiles.get(profileId)!;
  }
  
  /**
   * Update LSN for a client profile
   */
  public updateLSN(profileId: number, lsn: string): void {
    const profile = this.profiles.get(profileId);
    if (profile) {
      profile.lsn = lsn;
      profile.timestamp = Date.now();
      this.saveProfiles();
    }
  }
  
  /**
   * Clear the active client from a profile
   * This is kept for backward compatibility but simplified
   * @param clientId The client ID
   * @param profileId The profile ID
   */
  public clearActiveClientId(profileId: number, clientId: string): boolean {
    const profile = this.profiles.get(profileId);
    
    if (!profile) {
      this.logger.warn(`Profile ${profileId} not found when clearing client ID`);
      return false;
    }
    
    // Since we're using profile.id as clientId, we just log this action
    this.logger.info(`Cleared active client ${clientId} from profile ${profileId}`);
    return true;
  }
  
  /**
   * Record a test run for a client profile
   */
  public recordTestRun(profileId: number, testType: 'initial' | 'liveSync' | 'catchup'): void {
    const profile = this.profiles.get(profileId);
    if (profile) {
      profile.testHistory[testType]++;
      profile.timestamp = Date.now();
      this.saveProfiles();
    }
  }
  
  /**
   * Get all client profiles
   */
  public getAllProfiles(): ClientProfile[] {
    return Array.from(this.profiles.values());
  }
  
  /**
   * Delete a client profile
   */
  public deleteProfile(profileId: number): boolean {
    const deleted = this.profiles.delete(profileId);
    if (deleted) {
      this.saveProfiles();
      this.logger.info(`Deleted client profile ID: ${profileId}`);
    }
    return deleted;
  }
  
  /**
   * Get client ID from profile
   * Simplified to just return the profile's ID as the client ID
   * @param profileId The profile ID to use
   * @returns The client ID and profile
   */
  public async getOrReuseClient(profileId: number = 1): Promise<{clientId: string, profile: ClientProfile}> {
    // Get the profile first
    const profile = await this.getProfile(profileId);
    
    // Use the profile's ID as the client ID
    const clientId = profile.id;
    
    this.logger.info(`Using client ID ${clientId} for profile ${profileId}`);
    return { clientId, profile };
  }
} 