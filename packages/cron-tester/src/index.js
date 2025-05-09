/**
 * Cron Tester
 * 
 * This script sends periodic requests to the scheduled handler endpoint
 * to keep the replication DO active during local development.
 */
const http = require('http');

// Configuration
const POLL_INTERVAL_MS = 60000; // 1 minute
const INITIAL_DELAY_MS = 5000;  // 5 seconds before first trigger
const SERVER_PORT = 8787;       // Default Cloudflare Workers port for wrangler dev

/**
 * Triggers the scheduled handler endpoint
 */
function triggerCron() {
  const options = {
    hostname: 'localhost',
    port: SERVER_PORT,
    path: '/cdn-cgi/handler/scheduled',
    method: 'GET'
  };

  const req = http.request(options, (res) => {
    const timestamp = new Date().toISOString();
    console.log(`[CRON-TESTER] ${timestamp} - Triggered replication DO heartbeat - Status: ${res.statusCode}`);
    
    // Optionally read and log the response body
    let data = '';
    res.on('data', (chunk) => {
      data += chunk;
    });
    res.on('end', () => {
      if (data) {
        try {
          const parsed = JSON.parse(data);
          console.log(`[CRON-TESTER] Response: Success=${parsed.success}, AlreadyInitialized=${parsed.alreadyInitialized}`);
        } catch (parseError) {
          console.error(`[CRON-TESTER] Failed to parse JSON response. Error: ${parseError.message}`);
          // Log the first 200 chars of the problematic data
          const preview = data.length > 200 ? data.substring(0, 200) + '...' : data;
          console.log(`[CRON-TESTER] Raw Response Data: "${preview}"`);
          if (data.length > 200) {
            console.log(`[CRON-TESTER] (Full response length: ${data.length} bytes)`);
          }
        }
      }
    });
  });

  req.on('error', (e) => {
    // If server isn't ready yet, don't spam the console
    if (e.code === 'ECONNREFUSED') {
      console.log(`[CRON-TESTER] Waiting for server to start...`);
    } else {
      console.error(`[CRON-TESTER] Error: ${e.message}`);
    }
  });

  req.end();
}

// Print startup message
console.log('[CRON-TESTER] Starting cron trigger service');
console.log(`[CRON-TESTER] Will trigger every ${POLL_INTERVAL_MS/1000} seconds`);
console.log(`[CRON-TESTER] First trigger in ${INITIAL_DELAY_MS/1000} seconds`);

// Only start once server has likely started
setTimeout(() => {
  // Trigger immediately after initial delay
  triggerCron();
  
  // Then trigger periodically
  setInterval(triggerCron, POLL_INTERVAL_MS);
}, INITIAL_DELAY_MS);

// Keep process running
process.on('SIGINT', () => {
  console.log('[CRON-TESTER] Shutting down cron trigger service');
  process.exit(0);
}); 