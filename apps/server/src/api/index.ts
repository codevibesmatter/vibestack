import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { cors } from 'hono/cors'
import type { ApiEnv } from '../types/api'
import { projects } from './projects'
import { tasks } from './tasks'
import { users } from './users'
import { sync } from './sync'
import replication from './replication'
import { migrations } from './migrations'
import { db } from './db'
import { HTTPException } from 'hono/http-exception'
import { serverLogger as log } from '../middleware/logger'
import type { AppBindings } from '../types/hono'
import authRoutes from './routes/auth'
import internalAuthRoutes from './routes/internalAuth'

// Create API router
const api = new Hono<ApiEnv>()

// Global middleware
api.use('*', logger())
api.use('*', cors())

// Mount routes with proper prefixes
api.route('/projects', projects)
api.route('/tasks', tasks)
api.route('/users', users)
api.route('/sync', sync)
api.route('/replication', replication)
api.route('/migrations', migrations)
api.route('/db', db)
api.route('/auth', authRoutes)
api.route('/internal/auth', internalAuthRoutes)

// Basic health check endpoint
api.get('/health', (c) => {
  return c.text('Server OK')
})

export default api
export type ApiType = typeof api  // For client type generation 