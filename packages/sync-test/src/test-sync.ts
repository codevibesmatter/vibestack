import WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';
import type { 
  SrvMessageType, 
  CltMessageType, 
  TableChange,
  ServerMessage,
  ServerChangesMessage,
  ServerInitChangesMessage,
  ServerStateChangeMessage,
  ServerReceivedMessage,
  ServerAppliedMessage,
  ClientMessage,
  ClientChangesMessage,
  ClientHeartbeatMessage,
  ClientReceivedMessage,
  ClientAppliedMessage,
  Message,
  ServerLSNUpdateMessage
} from '@repo/sync-types';
import inquirer from 'inquirer';
import { serverDataSource } from '@repo/dataforge';
import { 
  Task, TaskStatus, TaskPriority,
  Project, ProjectStatus,
  User,
  Comment,
  SERVER_DOMAIN_TABLES
} from '@repo/dataforge/server-entities';
import type { EntityTarget } from 'typeorm';
import { generateSingleChange, generateBulkChanges } from './changes/client-changes.js';
import { createServerChange, createServerBulkChanges } from './changes/server-changes.js';
import type { Config } from './types.js';
import { DEFAULT_CONFIG } from './config.js';
import fs from 'fs';
import path from 'path';

type EntityMap = {
  users: typeof User;
  projects: typeof Project;
  tasks: typeof Task;
  comments: typeof Comment;
};

const ENTITY_MAP = {
  tasks: Task,
  projects: Project,
  users: User,
  comments: Comment
} as const;

type TableName = typeof SERVER_DOMAIN_TABLES[number];

interface PendingChunkSet {
  chunks: TableChange[][];
  timer: NodeJS.Timeout;
  startTime: number;
  receivedCount: number;
  totalSize: number;
}

export class SyncTester {
  protected config: Config;
  protected clientId: string;
  private connected: boolean;
  private messageLog: Message[];
  private messageId: number;
  private ws: WebSocket | null;
  private currentState: 'initial' | 'catchup' | 'live';
  private serverLSN: string = '0/0';

  constructor(config: Partial<Config> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.clientId = uuidv4();
    this.connected = false;
    this.messageLog = [];
    this.messageId = 0;
    this.ws = null;
    this.currentState = 'initial';
  }

  // Connect with optional LSN and client ID for catchup sync
  public async connect(lsn?: string, clientId?: string): Promise<void> {
    if (this.connected) {
      throw new Error('Already connected');
    }
    
    // Use provided client ID if available
    if (clientId) {
      this.clientId = clientId;
    }
    
    // Build URL with parameters
    const wsUrl = new URL(this.config.wsUrl);
    wsUrl.searchParams.set('clientId', this.clientId);
    if (lsn) {
      wsUrl.searchParams.set('lsn', lsn);
    }
    
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl.toString());
      
      this.ws.on('open', () => {
        this.connected = true;
        resolve();
      });

      this.ws.on('message', (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString()) as Message;
          this.handleMessage(message);
        } catch (err) {
          console.error('Error parsing message:', err);
        }
      });

      this.ws.on('error', (error: Error) => {
        console.error('WebSocket error:', error);
        reject(error);
      });

      this.ws.on('close', () => {
        this.connected = false;
        this.ws = null;
      });

      // Connection timeout
      setTimeout(() => {
        if (!this.connected) {
          reject(new Error('Connection timeout'));
        }
      }, this.config.connectTimeout);
    });
  }

  public async disconnect(code?: number, reason?: string): Promise<void> {
    if (this.ws) {
      this.ws.close(code, reason);
    }
    this.connected = false;
    this.ws = null;
  }

  public async sendMessage(message: Message): Promise<void> {
    if (!this.connected || !this.ws) {
      throw new Error('Not connected');
    }
    await new Promise<void>((resolve, reject) => {
      this.ws!.send(JSON.stringify(message), (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private handleMessage(message: Message): void {
    // Add message to log
    this.messageLog.push(message);
    
    // Process messages that could affect sync state
    if ('type' in message) {
      // Handle legacy state change messages
      if (message.type === 'srv_state_change') {
        const stateMsg = message as ServerStateChangeMessage;
        this.currentState = stateMsg.state;
        this.serverLSN = stateMsg.lsn;
        console.log(`State changed to ${stateMsg.state} with LSN ${stateMsg.lsn}`);
      } 
      // Handle new LSN update messages 
      else if (message.type === 'srv_lsn_update') {
        const lsnMsg = message as ServerLSNUpdateMessage;
        this.serverLSN = lsnMsg.lsn;
        
        // Update state based on LSN
        // For catchup sync, LSN update to a new value means we're now live
        // This assumes server sends LSN update when catchup is complete
        this.currentState = 'live';
        console.log(`LSN updated to ${lsnMsg.lsn}, transitioning to 'live' state`);
      }
    }
  }

  // Helper methods for tests
  public getMessagesByType<T extends Message>(type: string): T[] {
    return this.messageLog.filter(msg => msg.type === type) as T[];
  }

  public getLastMessage<T extends Message>(type: string): T | undefined {
    const messages = this.messageLog.filter((msg: Message) => msg.type === type);
    return messages[messages.length - 1] as T | undefined;
  }

  public getCurrentState(): 'initial' | 'catchup' | 'live' {
    return this.currentState;
  }

  public getServerLSN(): string {
    return this.serverLSN;
  }

  public clearMessageLog(): void {
    this.messageLog = [];
  }

  /**
   * Get the message log for analysis
   */
  public getMessageLog(): Message[] {
    return this.messageLog;
  }

  /**
   * Get the client ID
   */
  public getClientId(): string {
    return this.clientId;
  }

  protected nextMessageId(): string {
    return `clt_${Date.now()}_${this.messageId++}`;
  }

  /**
   * Run the test scenario
   */
  public async runTest(): Promise<void> {
    // Wait for initial sync to complete
    await this.waitForState('live');
    
    // Run basic validation
    await this.validateSync();
    
    // Disconnect cleanly
    await this.disconnect(1000, 'Test complete');
  }

  /**
   * Wait for a specific sync state
   */
  private async waitForState(targetState: 'initial' | 'catchup' | 'live', timeout = 30000): Promise<void> {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const checkState = () => {
        if (this.currentState === targetState) {
        resolve();
        } else if (Date.now() - start > timeout) {
          reject(new Error(`Timeout waiting for state ${targetState}`));
        } else {
          setTimeout(checkState, 100);
        }
      };
      checkState();
    });
  }

  /**
   * Validate the sync process
   */
  private async validateSync(): Promise<void> {
    // Basic validation that we received messages in order
    const initStart = this.messageLog.find(m => m.type === 'srv_init_start');
    const initComplete = this.messageLog.find(m => m.type === 'srv_init_complete');
    
    // Check for either state change or LSN update
    const stateChange = this.messageLog.find(m => m.type === 'srv_state_change');
    const lsnUpdate = this.messageLog.find(m => m.type === 'srv_lsn_update');
    
    // For catchup sync, we might not have init messages
    if (!initStart && !initComplete) {
      // In catchup sync we should at least have an LSN update
      if (!lsnUpdate) {
        throw new Error('Missing srv_lsn_update message in catchup sync');
      }
      return;
    }

    // For initial sync, validate init messages
    if (!initStart) throw new Error('Missing srv_init_start message');
    if (!initComplete) throw new Error('Missing srv_init_complete message');
    
    // Validate message order for state transition
    if (stateChange || lsnUpdate) {
      const initStartIndex = this.messageLog.indexOf(initStart);
      const initCompleteIndex = this.messageLog.indexOf(initComplete);
      
      if (initStartIndex > initCompleteIndex) {
        throw new Error('srv_init_start received after srv_init_complete');
      }
      
      if (stateChange) {
        const stateChangeIndex = this.messageLog.indexOf(stateChange);
        if (initCompleteIndex > stateChangeIndex) {
          throw new Error('srv_init_complete received after srv_state_change');
        }
      }
      
      if (lsnUpdate) {
        const lsnUpdateIndex = this.messageLog.indexOf(lsnUpdate);
        if (initCompleteIndex > lsnUpdateIndex) {
          throw new Error('srv_init_complete received after srv_lsn_update');
        }
      }
    } else {
      throw new Error('Missing state transition message (srv_state_change or srv_lsn_update)');
    }
  }
} 