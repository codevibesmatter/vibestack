import React, { ErrorInfo, Suspense } from 'react';
import { LiveQueryDebugPanel } from './components/LiveQueryDebugPanel';
import { DebugNavigation } from './components/DebugNavigation';
import { Header } from '@/components/layout/header';
import { Main } from '@/components/layout/main';
import { ProfileDropdown } from '@/components/profile-dropdown';
import { Search } from '@/components/search';
import { ThemeSwitch } from '@/components/theme-switch';
import { Card, CardContent } from '@/components/ui/card';

// Error boundary component
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Error in component:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <Card className="mt-4">
          <CardContent className="pt-6">
            <h3 className="text-xl font-medium text-destructive">Error Loading Debug Panel</h3>
            <p className="mt-2">There was an error loading the debug panel:</p>
            <pre className="mt-2 p-2 bg-muted rounded-md text-xs overflow-auto">
              {this.state.error?.message || 'Unknown error'}
            </pre>
            <button 
              className="mt-4 px-4 py-2 bg-primary text-primary-foreground rounded-md"
              onClick={() => this.setState({ hasError: false, error: null })}
            >
              Try Again
            </button>
          </CardContent>
        </Card>
      );
    }

    return this.props.children;
  }
}

export function LiveQueryDebugPage() {
  return (
    <>
      <Header fixed>
        <Search />
        <div className='ml-auto flex items-center space-x-4'>
          <ThemeSwitch />
          <ProfileDropdown />
        </div>
      </Header>
      <Main>
        <div className="mb-2 flex items-center justify-between space-y-2">
          <h1 className='text-2xl font-bold tracking-tight'>Live Query Debug</h1>
        </div>
        
        <ErrorBoundary>
          <Suspense fallback={<div>Loading debug panel...</div>}>
            <LiveQueryDebugPanel />
          </Suspense>
        </ErrorBoundary>
        
        <DebugNavigation />
      </Main>
    </>
  );
}

export default LiveQueryDebugPage; 