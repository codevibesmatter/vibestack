import { Hono } from 'hono'
import { logger } from 'hono/logger'
// Remove cors import again
// import { cors } from 'hono/cors' 
import type { ApiEnv } from '../types/api'
import { projects } from './projects'
import { tasks } from './tasks'
import { users } from './users'
import { sync } from './sync'
import replication from './replication'
import { migrations } from './migrations'
import { db } from './db'
import authRouter from './auth'
import { HTTPException } from 'hono/http-exception'
import { serverLogger as log } from '../middleware/logger'
import type { AppBindings } from '../types/hono'

// Create API router
const api = new Hono<ApiEnv>()

// Global middleware
api.use('*', logger())

// REMOVE path-specific CORS middleware here - it will be handled in src/index.ts
// api.use('/auth/*', cors({...}))

// Mount routes with proper prefixes
api.route('/projects', projects)
api.route('/tasks', tasks)
api.route('/users', users)
api.route('/sync', sync)
api.route('/replication', replication)
api.route('/migrations', migrations)
api.route('/db', db)
api.route('/auth', authRouter)

// Basic health check endpoint
api.get('/health', (c) => {
  return c.text('Server OK')
})

export default api
export type ApiType = typeof api 