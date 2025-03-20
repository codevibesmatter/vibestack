import { Hono } from 'hono';
import type { ApiEnv } from '../types/api';

const replication = new Hono<ApiEnv>();

// Forward all requests to the Durable Object
replication.all('*', async (c) => {
  const id = c.env.REPLICATION.idFromName('replication');
  const obj = c.env.REPLICATION.get(id);
  
  // Forward the request and get response
  const response = await obj.fetch(c.req.raw);
  
  // Create a new response with the same body but mutable headers
  const body = await response.text();
  return new Response(body, {
    status: response.status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': '*'
    }
  });
});

export default replication; 