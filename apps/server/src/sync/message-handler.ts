import { 
  SyncMessageType,
  isClientMessageType,
  MessageFields,
  CltSyncRequest,
  CltChanges,
  CltChangesReceived,
  CltChangesApplied,
  SrvError,
  SrvChanges,
  SrvChangesReceived,
  SrvChangesApplied
} from '@repo/sync-types';

import { syncLogger } from '../middleware/logger';
import type { MinimalContext } from '../types/hono';
import { processClientChanges } from './client-changes';
import { processSyncRequest } from './server-changes';

/**
 * Context for message processing
 */
export interface MessageContext {
  clientId: string;
  context: MinimalContext;
  lastLSN?: string;
  updateLSN?: (lsn: string) => void;
}

/**
 * Interface for sending messages back to the client
 */
export interface MessageSender {
  send(message: SrvChanges | SrvChangesReceived | SrvChangesApplied | SrvError): Promise<void>;
  isConnected(): boolean;
}

/**
 * Process a message from a client
 */
export async function processMessage(
  message: MessageFields & { type: string }, 
  ctx: MessageContext,
  sender: MessageSender
): Promise<void> {
  syncLogger.info('Processing message:', {
    type: message.type,
    clientId: message.clientId,
    messageId: message.messageId
  });

  try {
    if (!isClientMessageType(message.type)) {
      if (message.type.startsWith('srv_')) {
        syncLogger.warn('Received server message, ignoring:', message.type);
        return;
      }
      await sendError(sender, ctx.clientId, { code: 'UNKNOWN_MESSAGE_TYPE', message: `Unknown message type: ${message.type}` });
      return;
    }

    switch (message.type) {
      case 'clt_sync_request': {
        if (!('lastLSN' in message)) {
          throw new Error('Missing lastLSN in sync request');
        }
        await processSyncRequest(message as CltSyncRequest, ctx, sender);
        break;
      }

      case 'clt_changes': {
        if (!('changes' in message)) {
          throw new Error('Missing changes in changes message');
        }
        await processClientChanges(message as CltChanges, ctx, sender);
        break;
      }

      case 'clt_changes_received': {
        if (!('lastLSN' in message)) {
          throw new Error('Missing lastLSN in changes received message');
        }
        syncLogger.info('Client received changes', {
          clientId: message.clientId,
          lastLSN: message.lastLSN
        });
        break;
      }

      case 'clt_changes_applied': {
        if (!('lastLSN' in message) || !('appliedChanges' in message)) {
          throw new Error('Missing required fields in changes applied message');
        }
        syncLogger.info('Client applied changes', {
          clientId: message.clientId,
          lastLSN: message.lastLSN,
          appliedChanges: message.appliedChanges
        });
        break;
      }

      default:
        syncLogger.warn('Unknown message type:', message.type);
        await sendError(sender, ctx.clientId, { code: 'UNKNOWN_MESSAGE_TYPE', message: `Unknown message type: ${message.type}` });
    }
  } catch (error) {
    syncLogger.error('Error processing message:', error);
    await sendError(sender, ctx.clientId, { 
      code: 'PROCESSING_ERROR', 
      message: error instanceof Error ? error.message : 'Unknown error' 
    });
  }
}

async function sendError(
  sender: MessageSender, 
  clientId: string, 
  error: { code: string; message: string; details?: unknown }
) {
  const errorMessage: SrvError = {
    type: 'srv_error',
    messageId: `srv_${Date.now()}`,
    timestamp: Date.now(),
    clientId,
    code: error.code,
    message: error.message,
    details: error.details
  };

  await sender.send(errorMessage);
} 