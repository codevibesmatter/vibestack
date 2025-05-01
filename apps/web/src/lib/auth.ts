import { createAuthClient } from "better-auth/react"; // Use React client

// Define the base URL for the Better Auth server
// In production, this should come from an environment variable
const authApiBaseUrl = import.meta.env.VITE_API_URL || "http://127.0.0.1:8787";

// Create the Better Auth client instance
export const authClient = createAuthClient({
  baseURL: `${authApiBaseUrl}/api/auth`,
  credentials: 'include', // Ensure credentials are sent with requests
  headers: {
    'Content-Type': 'application/json',
  },
  mode: 'cors',
  fetch: (url: string, options: RequestInit) => {
    console.log(`[AUTH] Fetch request to: ${url}`);
    console.log('[AUTH] Request options:', JSON.stringify({
      method: options.method,
      headers: options.headers,
      credentials: options.credentials,
      mode: options.mode
    }, null, 2));
    
    // Ensure cookies are sent
    const enhancedOptions = {
      ...options,
      credentials: 'include' as RequestCredentials,
    };
    
    return fetch(url, enhancedOptions).then(response => {
      console.log(`[AUTH] Response status: ${response.status}`);
      console.log(`[AUTH] Response headers:`, Object.fromEntries(response.headers.entries()));
      return response;
    }).catch(error => {
      console.error('[AUTH] Fetch error:', error);
      throw error;
    });
  }
});

// No longer need redirectUri for PKCE
// export const redirectUri = `${window.location.origin}/auth/callback`;

/**
 * Initiates the sign-in process using Better Auth.
 * Replace with specific sign-in logic (e.g., opening a modal, navigating to a page)
 */
export const initiateSignIn = async (/* Add necessary parameters like email, password */) => {
  try {
    console.log(`[AUTH] Attempting sign-in via: ${authApiBaseUrl}`);
    // Example: Call Better Auth sign-in method
    // const result = await authClient.signIn('email', { email, password });
    // console.log("[AUTH] Sign-in successful:", result);
    // Handle success (e.g., redirect, update state)
    alert("Sign-in logic needs implementation using authClient.signIn");
  } catch (error) {
    console.error("[AUTH] Failed to initiate sign-in:", error);
    alert("Sign-in failed. Please check the console.");
  }
};

/**
 * Initiates the sign-up process using Better Auth.
 * Replace with specific sign-up logic
 */
export const initiateSignUp = async (/* Add necessary parameters */) => {
  try {
    console.log(`[AUTH] Attempting sign-up via: ${authApiBaseUrl}`);
    // Example: Call Better Auth sign-up method
    // const result = await authClient.signUp('email', { email, password, name });
    // console.log("[AUTH] Sign-up successful:", result);
    // Handle success
    alert("Sign-up logic needs implementation using authClient.signUp");
  } catch (error) {
    console.error("[AUTH] Failed to initiate sign-up:", error);
    alert("Sign-up failed. Please check the console.");
  }
};

// Add other necessary functions like signOut, useSession hook integration, etc.
// Example:
// export const signOut = async () => { 
//   await authClient.signOut(); 
//   // Handle post-sign-out logic (e.g., redirect)
// }; 