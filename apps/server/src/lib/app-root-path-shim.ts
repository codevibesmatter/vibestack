// apps/server/src/lib/app-root-path-shim.ts
// Provides a compatible shim for the 'app-root-path' module in Cloudflare Workers

const dummyPath = '/virtual/worker/root'; // A placeholder root path

// Define the shim object with default and named exports
const shim = {
  path: dummyPath,
  toString: (): string => dummyPath,
  resolve: (relativePath: string): string => {
    // Simple path joining, handling potential leading slash
    const cleanRelativePath = relativePath.startsWith('/') ? relativePath.substring(1) : relativePath;
    return `${dummyPath}/${cleanRelativePath}`;
  },
  require: (id: string): never => { 
    // Prevent the shim from being used to require other modules
    throw new Error(`app-root-path shim cannot require '${id}'`); 
  },
  setPath: (/* explicitPath: string */): void => { 
    // No-op for any configuration attempts via setPath
    console.warn('[app-root-path-shim] setPath called, but it has no effect in this environment.');
  } 
};

// Export named constants for compatibility
export const path: string = shim.path;
export const resolve: (relativePath: string) => string = shim.resolve;
export const toString: () => string = shim.toString;
export const setPath: (explicitPath: string) => void = shim.setPath;

// Export the default object
export default shim; 