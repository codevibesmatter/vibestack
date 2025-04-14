import { createLogger } from './logger.ts';
import fetch from 'node-fetch';
import { API_CONFIG } from '../config.ts';

// Logger instance
const logger = createLogger('sync.api');

/**
 * Initialize replication by calling the server API
 */
export async function initializeReplication(): Promise<void> {
  logger.info('Initializing replication via API');
  
  try {
    // Use API_CONFIG from config.ts
    const baseUrl = API_CONFIG.BASE_URL;
    const endpoint = API_CONFIG.REPLICATION_INIT;
    const initUrl = `${baseUrl}${endpoint}`;
    
    logger.info(`Making API call to initialize replication: ${initUrl}`);
    
    const response = await fetch(initUrl, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      }
    });
    
    if (!response.ok) {
      throw new Error(`API request failed: ${response.status} ${response.statusText}`);
    }
    
    const result = await response.json();
    logger.info(`Replication initialization successful via API: ${JSON.stringify(result)}`);
  } catch (error) {
    logger.error(`Error initializing replication via API: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

/**
 * Get the current LSN value from the API
 */
export async function getCurrentLSN(): Promise<string> {
  logger.info('Getting current LSN via API');
  
  try {
    // Use API_CONFIG from config.ts
    const baseUrl = API_CONFIG.BASE_URL;
    const endpoint = API_CONFIG.GET_LSN;
    const lsnUrl = `${baseUrl}${endpoint}`;
    
    logger.info(`Making API call to get current LSN: ${lsnUrl}`);
    
    const response = await fetch(lsnUrl, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      }
    });
    
    if (!response.ok) {
      throw new Error(`API request failed: ${response.status} ${response.statusText}`);
    }
    
    const result = await response.json() as { lsn?: string };
    const lsn = result.lsn || '0/0';
    
    logger.info(`Current LSN from API: ${lsn}`);
    return lsn;
  } catch (error) {
    logger.error(`Error getting current LSN via API: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
} 