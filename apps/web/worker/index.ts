interface Env {
  // If you set up bindings in your wrangler.toml, define their types here.
  // For example, if you have a KV namespace:
  // MY_KV_NAMESPACE: KVNamespace;
  // Or if you have a Durable Object:
  // MY_DURABLE_OBJECT: DurableObjectNamespace;
  // Or if you have an R2 bucket:
  // MY_BUCKET: R2Bucket;
  // Note: When using Static Assets, you need to define the ASSETS binding:
  ASSETS: Fetcher;
}

export default {
  // The fetch handler is invoked when a request is made to the Worker.
  // It requires parameters for the request object, environment bindings, and execution context.
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Route requests starting with /api/ to the API handler
    if (url.pathname.startsWith("/api/")) {
      // Simple API endpoint example
      // In a real app, you'd likely have more robust routing here.
      return Response.json({
        name: "Cloudflare", // Data returned by the API
        message: "Hello from the Worker API!",
        timestamp: new Date().toISOString(),
      });
    }

    // For non-API requests that aren't static assets handled by the `assets` config,
    // the Cloudflare Vite plugin expects a 404 response for SPA mode.
    // The plugin intercepts navigation requests (HTML) and invokes the
    // `not_found_handling = "single-page-application"` behavior from wrangler.toml.
    // For other non-asset, non-API requests (like fetching a non-existent image), 
    // returning a 404 is appropriate.
    return new Response(null, { status: 404 });

    // Important Note from Tutorial regarding ASSETS binding:
    // The tutorial *sometimes* shows using env.ASSETS.fetch(request) as a fallback.
    // However, with `assets = { not_found_handling = "single-page-application" }` 
    // and the Vite plugin, this is usually handled automatically for navigation requests.
    // Manually calling env.ASSETS.fetch might interfere with the plugin's SPA handling.
    // The safest approach for SPA mode is often to let the plugin handle asset serving
    // and return 404 for unhandled non-API requests.
    // If you were *not* using SPA mode or had different asset handling needs,
    // you might use: return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>; 