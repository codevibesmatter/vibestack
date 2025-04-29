import { createClient } from "@openauthjs/openauth/client";

// Use environment variables or fallback for local dev
const issuerUrl = import.meta.env.VITE_AUTH_ISSUER_URL || "http://localhost:3001";
const clientId = import.meta.env.VITE_AUTH_CLIENT_ID || "vibestack-web";

if (!import.meta.env.VITE_AUTH_ISSUER_URL) {
    console.warn("VITE_AUTH_ISSUER_URL not set, defaulting to http://localhost:3001");
}
if (!import.meta.env.VITE_AUTH_CLIENT_ID) {
    console.warn("VITE_AUTH_CLIENT_ID not set, defaulting to vibestack-web");
}

export const authClient = createClient({
  issuer: issuerUrl,
  clientID: clientId,
});

// The URL in *your* app where OpenAuth redirects back to
export const redirectUri = `${window.location.origin}/auth/callback`;

/**
 * Initiates the PKCE login flow and redirects the user to the OpenAuth UI.
 */
export const redirectToLogin = async () => {
  try {
    console.log(`[AUTH] Redirecting to login via issuer: ${issuerUrl}`);
    // PKCE is still used, but challenge is handled by server callback now
    const { url /*, challenge */ } = await authClient.authorize(
      redirectUri, // This tells OpenAuth where to send the code *initially*
      "code",
      { pkce: true } // PKCE needed for SPA initiation
    );
    // No longer need to store challenge in localStorage
    // localStorage.setItem('pkce_challenge', JSON.stringify(challenge)); 
    console.log(`[AUTH] Redirecting user to OpenAuth: ${url}`);
    window.location.href = url;
  } catch (error) {
    console.error("[AUTH] Failed to initiate login redirect:", error);
    alert("Failed to initiate login. Please check the console.");
  }
}; 