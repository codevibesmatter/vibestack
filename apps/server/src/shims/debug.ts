// Simple debug implementation that TypeORM depends on
// This is a minimal shim for Cloudflare Workers environment
function createDebug(namespace: string) {
  // Create a no-op function that matches the debug package API
  // but doesn't actually output anything by default
  const debugFn = (...args: any[]) => {
    // No-op by default
    // In Workers, we don't have process.env.NODE_ENV, so we can't conditionally log
  };
  
  // Add the expected properties that TypeORM might use
  debugFn.enabled = false;
  debugFn.color = '';
  debugFn.namespace = namespace;
  debugFn.extend = (suffix: string) => createDebug(`${namespace}:${suffix}`);
  
  return debugFn;
}

// Export as the same shape that TypeORM expects
export const debug = createDebug;
export default createDebug; 