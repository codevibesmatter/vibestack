import * as React from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { AlertCircle, RefreshCw } from 'lucide-react'
import { useDataTable } from './data-table-provider'

/**
 * Error state component for the data table
 */
export function DataTableError({
  error,
  onRetry,
  title,
  description,
}: {
  error: Error | string
  onRetry?: () => void
  title?: string
  description?: string
}) {
  const { config } = useDataTable?.() || { config: { errorMessage: 'An error occurred while loading data.' } }
  
  // Extract error message
  const errorMessage = error instanceof Error ? error.message : error
  
  return (
    <Card className="w-full my-4 border-destructive/50">
      <CardContent className="pt-6">
        <div className="flex flex-col items-center text-center sm:flex-row sm:text-left">
          <AlertCircle className="h-10 w-10 text-destructive mb-4 sm:mb-0 sm:mr-6" />
          <div>
            <h3 className="text-lg font-medium text-destructive">
              {title || config.errorMessage}
            </h3>
            
            {description && (
              <p className="mt-1 text-sm text-muted-foreground">{description}</p>
            )}
            
            <div className="mt-3 p-2 bg-muted/50 rounded-md text-xs overflow-auto text-left max-h-[200px]">
              <pre className="whitespace-pre-wrap">{errorMessage}</pre>
            </div>
            
            {onRetry && (
              <Button
                className="mt-4"
                size="sm"
                variant="outline"
                onClick={onRetry}
              >
                <RefreshCw className="mr-2 h-4 w-4" />
                Retry
              </Button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

/**
 * Error boundary for data table components
 */
export class DataTableErrorBoundary extends React.Component<
  { 
    children: React.ReactNode
    onError?: (error: Error, errorInfo: React.ErrorInfo) => void
    fallback?: React.ReactNode | ((error: Error, resetError: () => void) => React.ReactNode)
  },
  { 
    hasError: boolean
    error: Error | null
    retryCount: number
  }
> {
  constructor(props: any) {
    super(props)
    this.state = { hasError: false, error: null, retryCount: 0 }
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    // Callback for custom error handling
    this.props.onError?.(error, errorInfo)
    
    console.error('DataTable error:', error, errorInfo)
  }

  resetError = () => {
    this.setState(prev => ({
      hasError: false,
      error: null,
      retryCount: prev.retryCount + 1
    }))
  }

  render() {
    if (this.state.hasError) {
      // Use custom fallback if provided
      if (this.props.fallback) {
        if (typeof this.props.fallback === 'function' && this.state.error) {
          return (this.props.fallback as Function)(this.state.error, this.resetError)
        }
        return this.props.fallback
      }

      // Default error UI
      return (
        <DataTableError
          error={this.state.error || 'Unknown error'}
          onRetry={this.resetError}
          title="Error in Data Table"
          description="There was an error while rendering the data table component."
        />
      )
    }

    return this.props.children
  }
}

/**
 * Hook for managing data fetching with error handling
 */
export function useDataFetchWithErrorHandling<T>(
  fetchFn: () => Promise<T>,
  options?: {
    initialData?: T
    onError?: (error: Error) => void
    maxRetries?: number
    retryDelay?: number
  }
) {
  const { config } = useDataTable?.() || { 
    config: { retryOnError: true, maxRetryAttempts: 3 } 
  }
  
  const [data, setData] = React.useState<T | undefined>(options?.initialData)
  const [error, setError] = React.useState<Error | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [retryCount, setRetryCount] = React.useState(0)
  
  const maxRetries = options?.maxRetries ?? config.maxRetryAttempts ?? 3
  const retryDelay = options?.retryDelay ?? 1000
  
  // Function to fetch data
  const fetchData = React.useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      
      const result = await fetchFn()
      setData(result)
      setRetryCount(0) // Reset retry count on success
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      setError(error)
      options?.onError?.(error)
      
      // Auto-retry if configured
      if (config.retryOnError && retryCount < maxRetries) {
        setTimeout(() => {
          setRetryCount(prev => prev + 1)
          fetchData()
        }, retryDelay * Math.pow(2, retryCount)) // Exponential backoff
      }
    } finally {
      setLoading(false)
    }
  }, [fetchFn, retryCount, config.retryOnError, maxRetries, retryDelay, options])
  
  // Retry function for manual retry
  const retry = React.useCallback(() => {
    setRetryCount(0)
    fetchData()
  }, [fetchData])
  
  return { data, loading, error, retry, fetchData }
} 