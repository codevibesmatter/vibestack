import type { Tables } from '../core/store';
/**
 * WebSocket connection state
 */
export interface WebSocketConnection {
    ws: WebSocket;
    id: string;
    lastPing: number;
}
/**
 * WebSocket sync message format
 */
export interface SyncMessage {
    type: 'sync' | 'ping' | 'pong';
    data?: Tables;
    timestamp: number;
}
