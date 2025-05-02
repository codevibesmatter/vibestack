import { useState, useCallback } from 'react';
import { authClient } from '../../../lib/auth';
import { createFileRoute } from '@tanstack/react-router';
import { useAuthStore } from '@/stores/authStore';

export const Route = createFileRoute('/_authenticated/debug/auth')({
  component: AuthDebugPage,
});

// Helper function to capture and display raw response data
async function getRawResponseData(url: string, options: RequestInit): Promise<{
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: any;
  raw: string;
}> {
  const response = await fetch(url, options);
  
  // Get headers as an object
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  
  // Get raw text
  const rawText = await response.clone().text();
  
  // Try to parse as JSON if possible
  let body;
  try {
    body = await response.json();
  } catch (e) {
    body = { parseError: "Could not parse response as JSON", text: rawText };
  }
  
  return {
    status: response.status,
    statusText: response.statusText,
    headers,
    body,
    raw: rawText
  };
}

function AuthDebugPage() {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [rawResponse, setRawResponse] = useState<any>(null);
  const [email, setEmail] = useState('ben@getelevra.com');
  const [password, setPassword] = useState('P4ssiveH0use!');
  
  // Get auth state from store for comparison
  const { isAuthenticated, user } = useAuthStore();

  // Test sign-in and cookie handling
  const testSignIn = useCallback(async () => {
    setLoading(true);
    setResult(null);
    setError(null);
    setRawResponse(null);
    
    try {
      // First, directly make the sign-in request to capture all details
      const rawData = await getRawResponseData('/api/auth/sign-in/email', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email, password }),
      });
      
      setRawResponse(rawData);
      
      if (rawData.status !== 200) {
        throw new Error(`Sign-in failed with status ${rawData.status}`);
      }
      
      // Check if the response contains Set-Cookie header
      const setCookieHeader = rawData.headers['set-cookie'];
      const hasCookie = setCookieHeader || Object.keys(rawData.headers).some(h => h.toLowerCase() === 'set-cookie');
      
      setResult({
        signInSuccess: true,
        cookieReceived: hasCookie,
        setCookieHeader: setCookieHeader || "(Not visible to JavaScript)",
        responseData: rawData.body,
        corsHeaders: {
          'access-control-allow-origin': rawData.headers['access-control-allow-origin'],
          'access-control-allow-credentials': rawData.headers['access-control-allow-credentials'],
          'access-control-expose-headers': rawData.headers['access-control-expose-headers'],
        },
        authStoreState: {
          isAuthenticated,
          userId: user?.id,
        }
      });
      
      // Wait a moment to allow cookies to be set
      setTimeout(() => {
        // Then check for cookies
        const cookiesAfterSignIn = document.cookie.split(';').map(c => c.trim());
        setResult((prev: any) => ({
          ...prev,
          cookiesAfterSignIn
        }));
      }, 500);
      
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      console.error('[AUTH DEBUG] Sign-in error:', err);
    } finally {
      setLoading(false);
    }
  }, [email, password, isAuthenticated, user]);

  // Get session info using the Better Auth client
  const testSession = useCallback(async () => {
    setLoading(true);
    setResult(null);
    setError(null);
    setRawResponse(null);
    
    try {
      // First, make a direct fetch to get the raw response
      const rawData = await getRawResponseData('/api/auth/get-session', {
        method: 'GET',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
      });
      setRawResponse(rawData);
      
      // Then use the Better Auth client to get session info
      const session = await authClient.getSession();
      
      setResult({
        sessionData: session,
        authStoreState: {
          isAuthenticated,
          userId: user?.id
        },
        corsHeaders: {
          'access-control-allow-origin': rawData.headers['access-control-allow-origin'],
          'access-control-allow-credentials': rawData.headers['access-control-allow-credentials'],
          'access-control-expose-headers': rawData.headers['access-control-expose-headers'],
        },
        cookiesPresent: document.cookie.length > 0,
        cookieNames: document.cookie.split(';').map(c => c.trim().split('=')[0]).filter(Boolean)
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      console.error('[AUTH DEBUG] Session fetch error:', err);
    } finally {
      setLoading(false);
    }
  }, [isAuthenticated, user]);

  // Test making an authenticated request to the server
  const testAuthRequest = useCallback(async () => {
    setLoading(true);
    setResult(null);
    setError(null);
    setRawResponse(null);
    
    try {
      // Make a direct fetch request to the auth /me diagnostic endpoint
      const rawData = await getRawResponseData('/api/auth/me', {
        method: 'GET',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
      });
      
      setRawResponse(rawData);
      
      if (rawData.status !== 200) {
        throw new Error(`Request to /api/auth/me failed with status ${rawData.status}`);
      }
      
      setResult({
        userData: rawData.body,
        authStoreState: {
          isAuthenticated,
          userId: user?.id
        },
        corsHeaders: {
          'access-control-allow-origin': rawData.headers['access-control-allow-origin'],
          'access-control-allow-credentials': rawData.headers['access-control-allow-credentials'],
        },
        cookiesPresent: document.cookie.length > 0,
        cookieNames: document.cookie.split(';').map(c => c.trim().split('=')[0]).filter(Boolean)
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      console.error('[AUTH DEBUG] Auth /me request error:', err);
    } finally {
      setLoading(false);
    }
  }, [isAuthenticated, user]);

  return (
    <div className="p-4">
      <h1 className="text-2xl font-bold mb-4">Auth Debugging</h1>
      
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
        {/* Sign-in Test */}
        <div className="border rounded p-4">
          <h2 className="text-xl font-semibold mb-2">Test Sign-In</h2>
          <p className="mb-4">Test sign-in to check cookie reception and CORS</p>
          
          <div className="mb-4">
            <label className="block text-sm font-medium mb-1">Email</label>
            <input 
              type="email" 
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded border p-2"
            />
          </div>
          
          <div className="mb-4">
            <label className="block text-sm font-medium mb-1">Password</label>
            <input 
              type="password" 
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded border p-2"
            />
          </div>
          
          <button 
            onClick={testSignIn}
            disabled={loading}
            className="px-4 py-2 bg-purple-500 text-white rounded hover:bg-purple-600 disabled:bg-gray-400"
          >
            {loading ? 'Testing...' : 'Test Sign-In'}
          </button>
        </div>
        
        {/* Session Test */}
        <div className="border rounded p-4">
          <h2 className="text-xl font-semibold mb-2">Test Session Info</h2>
          <p className="mb-4">Check if you have a valid authentication session</p>
          <button 
            onClick={testSession}
            disabled={loading}
            className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 disabled:bg-gray-400"
          >
            {loading ? 'Loading...' : 'Get Session Info'}
          </button>
        </div>
        
        {/* API Test */}
        <div className="border rounded p-4">
          <h2 className="text-xl font-semibold mb-2">Test Auth Diagnostic API</h2>
          <p className="mb-4">Make a request to the auth diagnostic endpoint (/api/auth/me)</p>
          <button 
            onClick={testAuthRequest}
            disabled={loading}
            className="px-4 py-2 bg-green-500 text-white rounded hover:bg-green-600 disabled:bg-gray-400"
          >
            {loading ? 'Loading...' : 'Test /auth/me Endpoint'}
          </button>
        </div>
      </div>
      
      {/* Current Auth State */}
      <div className="border rounded p-4 mb-6">
        <h2 className="text-xl font-semibold mb-2">Current Auth State</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <h3 className="font-medium">Auth Store State:</h3>
            <p>Is Authenticated: <span className={isAuthenticated ? "text-green-600 font-bold" : "text-red-600 font-bold"}>{isAuthenticated ? 'Yes' : 'No'}</span></p>
            <p>User ID: {user?.id || 'None'}</p>
            <p className="mt-2 font-medium">Current Origin:</p>
            <p className="bg-purple-100 dark:bg-purple-900 p-1 rounded font-mono text-sm">{window.location.origin}</p>
          </div>
          <div>
            <h3 className="font-medium">Browser Cookies:</h3>
            <p>Cookies Present: <span className={document.cookie.length > 0 ? "text-green-600 font-bold" : "text-red-600 font-bold"}>{document.cookie.length > 0 ? 'Yes' : 'No'}</span></p>
            {document.cookie.length > 0 && (
              <div>
                <p>Cookie Names:</p>
                <ul className="list-disc list-inside">
                  {document.cookie.split(';').map(c => c.trim().split('=')[0]).filter(Boolean).map((name, i) => (
                    <li key={i}>{name}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      </div>
      
      {/* Results display */}
      {(result || error || rawResponse) && (
        <div className="mt-8 border rounded p-4">
          <h2 className="text-xl font-semibold mb-2">Results</h2>
          
          {error && (
            <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4 dark:bg-red-900 dark:border-red-800 dark:text-red-100">
              <p className="font-bold">Error</p>
              <p>{error}</p>
            </div>
          )}
          
          {/* CORS Headers Analysis */}
          {result?.corsHeaders && (
            <div className="mb-4">
              <h3 className="text-lg font-semibold mb-2">CORS Headers</h3>
              <div className="bg-blue-50 border border-blue-300 text-blue-700 px-4 py-3 rounded mb-4 dark:bg-blue-900 dark:border-blue-800 dark:text-blue-100">
                <p className="font-medium">Access-Control-Allow-Origin: <code className="bg-blue-100 dark:bg-blue-800 px-1 rounded">{result.corsHeaders['access-control-allow-origin'] || 'Not set'}</code></p>
                <p className="font-medium">Access-Control-Allow-Credentials: <code className="bg-blue-100 dark:bg-blue-800 px-1 rounded">{result.corsHeaders['access-control-allow-credentials'] || 'Not set'}</code></p>
                <p className="font-medium">Access-Control-Expose-Headers: <code className="bg-blue-100 dark:bg-blue-800 px-1 rounded">{result.corsHeaders['access-control-expose-headers'] || 'Not set'}</code></p>
                
                {/* CORS Analysis */}
                <div className="mt-2 pt-2 border-t border-blue-300 dark:border-blue-700">
                  <p className="font-medium">CORS Analysis:</p>
                  <ul className="list-disc list-inside">
                    {result.corsHeaders['access-control-allow-origin'] ? (
                      <li className="text-green-700 dark:text-green-400">Origin header is correctly set to match the request origin</li>
                    ) : (
                      <li className="text-red-700 dark:text-red-400">Missing Access-Control-Allow-Origin header!</li>
                    )}
                    
                    {result.corsHeaders['access-control-allow-credentials'] === 'true' ? (
                      <li className="text-green-700 dark:text-green-400">Credentials are allowed</li>
                    ) : (
                      <li className="text-red-700 dark:text-red-400">Credentials are not allowed!</li>
                    )}
                    
                    {result.corsHeaders['access-control-expose-headers']?.includes('Set-Cookie') ? (
                      <li className="text-green-700 dark:text-green-400">Set-Cookie header is exposed</li>
                    ) : (
                      <li className="text-amber-700 dark:text-amber-400">Set-Cookie header is not exposed (may not be needed)</li>
                    )}
                  </ul>
                </div>
              </div>
            </div>
          )}
          
          {/* Raw Response Data */}
          {rawResponse && (
            <div className="mb-4">
              <h3 className="text-lg font-semibold mb-2">Raw Response</h3>
              <div className="bg-gray-100 p-4 rounded dark:bg-gray-800 dark:text-gray-100 mb-4">
                <p><strong>Status:</strong> {rawResponse.status} {rawResponse.statusText}</p>
                <div className="mt-2">
                  <p><strong>Headers:</strong></p>
                  <ul className="list-disc list-inside">
                    {Object.entries(rawResponse.headers).map(([key, value]) => (
                      <li key={key}><code>{key}: {String(value)}</code></li>
                    ))}
                  </ul>
                </div>
                <div className="mt-2">
                  <p><strong>Raw Response:</strong></p>
                  <pre className="whitespace-pre-wrap overflow-auto max-h-60 text-xs mt-1 p-2 bg-gray-200 dark:bg-gray-700 rounded">
                    {typeof rawResponse.raw === 'string' ? rawResponse.raw : JSON.stringify(rawResponse.raw, null, 2)}
                  </pre>
                </div>
              </div>
            </div>
          )}
          
          {/* Processed Result */}
          {result && (
            <div>
              <h3 className="text-lg font-semibold mb-2">Processed Result</h3>
              <div className="bg-gray-100 p-4 rounded dark:bg-gray-800 dark:text-gray-100">
                <pre className="whitespace-pre-wrap overflow-auto max-h-96">
                  {JSON.stringify(result, null, 2)}
                </pre>
              </div>
            </div>
          )}
          
          <div className="mt-4 bg-yellow-50 border-l-4 border-yellow-400 p-4 dark:bg-yellow-900/30 dark:border-yellow-600 dark:text-yellow-100">
            <p className="text-sm text-yellow-700 dark:text-yellow-100">
              <strong>Debug Tips:</strong>
            </p>
            <ul className="list-disc list-inside text-sm text-yellow-700 dark:text-yellow-100 mt-1">
              <li>If CORS headers are wrong, authentication cookies won't be saved</li>
              <li>Check that Access-Control-Allow-Origin matches your frontend origin exactly</li>
              <li>Ensure Access-Control-Allow-Credentials is set to true</li>
              <li>Chrome DevTools → Application → Cookies shows HttpOnly cookies</li>
              <li>Try signing in again if your session might have expired</li>
            </ul>
          </div>
        </div>
      )}
    </div>
  );
} 