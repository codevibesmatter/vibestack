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
  ServerLSNUpdateMessage,
  ServerSyncCompletedMessage
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
import { generateSingleChange, generateBulkChanges } from './changes/client-changes.ts';
import { createServerChange, createServerBulkChanges } from './changes/server-changes.ts';
import type { Config } from './types.ts';
import { DEFAULT_CONFIG } from './config.ts';
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
  private serverLSN: string = '0/0';
  public onMessage: ((message: Message) => void) | null = null;

  constructor(config: Partial<Config> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.clientId = uuidv4();
    this.connected = false;
    this.messageLog = [];
    this.messageId = 0;
    this.ws = null;
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
          console.log(`Received message: ${message.type}`);
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

  /**
   * Handle an incoming message
   */
  private handleMessage(message: Message): void {
    // Add message to log
    this.messageLog.push(message);
    
    // Log all incoming messages with a basic type indicator
    if ('type' in message) {
      const type = message.type;
      const shortType = type.substring(0, 12);
      console.log(`📩 RECEIVED: ${shortType.padEnd(12)} (total messages: ${this.messageLog.length})`);
    }
    
    // Call the onMessage handler if set
    if (this.onMessage) {
      this.onMessage(message);
    }
    
    // Store LSN updates for later reference
    if ('type' in message && message.type === 'srv_lsn_update') {
      const lsnUpdateMessage = message as ServerLSNUpdateMessage;
      this.serverLSN = lsnUpdateMessage.lsn;
    }
  }

  // Helper methods for tests
  public getMessagesByType<T extends Message>(type: string): T[] {
    return this.messageLog.filter(msg => 'type' in msg && msg.type === type) as T[];
  }

  public getLastMessage<T extends Message>(type: string): T | undefined {
    const messages = this.messageLog.filter((msg: Message) => 'type' in msg && msg.type === type);
    return messages[messages.length - 1] as T | undefined;
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

  /**
   * Generate a unique message ID
   */
  protected nextMessageId(): string {
    return `clt_${Date.now()}_${this.messageId++}`;
  }

  /**
   * Check if tester is connected
   */
  public isConnected(): boolean {
    return this.connected;
  }

  /**
   * Get the WebSocket instance
   */
  public getWebSocket(): WebSocket {
    if (!this.ws) {
      throw new Error('Not connected');
    }
    return this.ws;
  }
} 