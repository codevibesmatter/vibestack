export type SrvMessageType = 
  | 'srv_changes'           // Server sends changes
  | 'srv_changes_received'  // Server acks client changes received
  | 'srv_changes_applied'   // Server acks client changes applied
  | 'srv_sync_init'        // Server initializes sync with client
  | 'srv_heartbeat'         // Server heartbeat
  | 'srv_error';           // Server error

export type CltMessageType =
  | 'clt_sync_request'      // Client requests sync
  | 'clt_changes'           // Client sends changes
  | 'clt_changes_received'  // Client acks server changes received
  | 'clt_changes_applied'   // Client acks changes applied
  | 'clt_heartbeat'         // Client heartbeat
  | 'clt_error';           // Client error