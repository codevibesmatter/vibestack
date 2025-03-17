import { openDB, type IDBPDatabase } from 'idb'

interface CachedQuery<T> {
  key: string
  query: string
  params: any[]
  data: T[]
  timestamp: number
  version: string
}

const CACHE_VERSION = '1'
const DB_NAME = 'vibestack-cache'
const STORE_NAME = 'queries'

class QueryCache {
  private db: IDBPDatabase | null = null

  async init() {
    if (this.db) return this.db

    const self = this
    this.db = await openDB(DB_NAME, 1, {
      upgrade(db, oldVersion, newVersion) {
        // Create store if it doesn't exist
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          // Use keyPath for automatic key handling
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'key' })
          // Create index on query for faster lookups
          store.createIndex('query', 'query', { unique: false })
        }
      },
      blocked() {
        console.warn('Cache database blocked - another instance is open')
      },
      blocking() {
        console.warn('Cache database blocking - closing old instance')
        self.db?.close()
      },
      terminated() {
        console.error('Cache database terminated unexpectedly')
        self.db = null
      }
    })

    return this.db
  }

  private getQueryKey(query: string, params: any[] = []): string {
    return `${query}:${JSON.stringify(params)}`
  }

  async get<T>(query: string, params: any[] = []): Promise<T[] | null> {
    if (!this.db) await this.init()
    
    const key = this.getQueryKey(query, params)
    const cached = await this.db!.get(STORE_NAME, key) as CachedQuery<T> | undefined

    if (cached && cached.version === CACHE_VERSION) {
      console.log(`Cache hit for query: ${query}`)
      return cached.data
    }

    console.log(`Cache miss for query: ${query}`)
    return null
  }

  async set<T>(query: string, params: any[] = [], data: T[]): Promise<void> {
    if (!this.db) await this.init()

    const key = this.getQueryKey(query, params)
    const entry: CachedQuery<T> = {
      key,
      query,
      params,
      data,
      timestamp: Date.now(),
      version: CACHE_VERSION
    }

    // Use put without explicit key since we're using keyPath
    await this.db!.put(STORE_NAME, entry)
    console.log(`Cache updated for query: ${query}`)
  }

  async clear(): Promise<void> {
    if (!this.db) await this.init()
    await this.db!.clear(STORE_NAME)
    console.log('Cache cleared')
  }
}

// Export singleton instance
export const queryCache = new QueryCache() 