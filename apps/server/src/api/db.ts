import { Hono } from 'hono';
import type { ApiEnv } from '../types/api';
import { fetchDomainTableData, checkDatabaseHealth } from '../lib/db';

export const db = new Hono<ApiEnv>();

// Health check endpoint
db.get('/health', async (c) => {
  const health = await checkDatabaseHealth(c);
  return c.json({
    success: health.healthy,
    data: health
  }, health.healthy ? 200 : 503);
});

// Fetch domain table data
db.get('/data', async (c) => {
  try {
    const tableData = await fetchDomainTableData(c);
    return c.json({
      success: true,
      data: tableData
    });
  } catch (error) {
    console.error('Error fetching table data:', error);
    return c.json({
      success: false,
      error: {
        message: error instanceof Error ? error.message : 'Failed to fetch table data'
      }
    }, 500);
  }
}); 