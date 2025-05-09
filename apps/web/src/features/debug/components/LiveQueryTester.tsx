import React, { useState, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { usePGliteContext } from '@/db/pglite-provider';
import { getDatabase } from '@/db/db';
import { v4 as uuidv4 } from 'uuid';

// Define a type for PGlite query results
interface PGliteQueryResults {
  rows?: any[];
  [key: string]: any;
}

export function LiveQueryTester() {
  const [sql, setSql] = useState('SELECT * FROM tasks ORDER BY updated_at DESC LIMIT 10');
  const [results, setResults] = useState<any[]>([]);
  const [liveResults, setLiveResults] = useState<any[]>([]);
  const [unsubscribe, setUnsubscribe] = useState<(() => Promise<void>) | null>(null);
  const [isLiveActive, setIsLiveActive] = useState(false);
  const [liveUpdateCount, setLiveUpdateCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  
  const { services } = usePGliteContext();
  
  const runRegularQuery = async () => {
    try {
      setError(null);
      const db = await getDatabase();
      const queryResults = await db.query(sql);
      setResults(queryResults.rows || []);
    } catch (err) {
      console.error('Error running regular query:', err);
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  
  const startLiveQuery = async () => {
    try {
      setError(null);
      // Cleanup any existing live query
      if (unsubscribe) {
        await unsubscribe();
        setUnsubscribe(null);
      }
      
      const db = await getDatabase();
      
      if (!db.live || !db.live.query) {
        setError('PGlite live query extension is not available');
        return;
      }
      
      const liveQueryResult = await db.live.query(
        sql, 
        [], 
        (results: PGliteQueryResults) => {
          console.log('Live query update received:', results);
          setLiveResults(results.rows || []);
          setLiveUpdateCount(prev => prev + 1);
        }
      );
      
      setUnsubscribe(() => liveQueryResult.unsubscribe);
      setIsLiveActive(true);
      setLiveResults(liveQueryResult.initialResults?.rows || []);
    } catch (err) {
      console.error('Error starting live query:', err);
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  
  const stopLiveQuery = async () => {
    if (unsubscribe) {
      try {
        await unsubscribe();
        setUnsubscribe(null);
        setIsLiveActive(false);
      } catch (err) {
        console.error('Error stopping live query:', err);
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  };
  
  const createTestData = async () => {
    if (!services?.tasks) return;
    
    try {
      const randomId = uuidv4().substring(0, 8);
      const newTask = await services.tasks.createTask({
        title: `Live Query Test ${randomId}`,
        description: 'This task was created to test live queries',
        projectId: (await services.projects.getAll())[0]?.id,
      });
      console.log('Created test task for live query:', newTask);
    } catch (err) {
      console.error('Error creating test data:', err);
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  
  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle>Live Query SQL Tester</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="sql-input">SQL Query</Label>
          <Input
            id="sql-input"
            value={sql}
            onChange={(e) => setSql(e.target.value)}
            placeholder="Enter SQL query..."
            className="font-mono"
          />
        </div>
        
        <div className="flex space-x-2">
          <Button onClick={runRegularQuery}>Run Regular Query</Button>
          {!isLiveActive ? (
            <Button onClick={startLiveQuery} variant="outline">Start Live Query</Button>
          ) : (
            <Button onClick={stopLiveQuery} variant="destructive">Stop Live Query</Button>
          )}
          <Button onClick={createTestData} variant="outline">Create Test Data</Button>
        </div>
        
        {error && (
          <div className="p-2 bg-destructive/10 text-destructive rounded-md">
            {error}
          </div>
        )}
        
        <div className="space-y-4">
          <div>
            <h3 className="text-lg font-medium">Regular Query Results</h3>
            <div className="border rounded-md mt-2 overflow-auto max-h-40">
              <pre className="p-2 text-xs">{JSON.stringify(results, null, 2)}</pre>
            </div>
          </div>
          
          <div>
            <h3 className="text-lg font-medium">
              Live Query Results 
              {isLiveActive && <span className="ml-2 text-sm text-muted-foreground">
                (Updates: {liveUpdateCount})
              </span>}
            </h3>
            <div className="border rounded-md mt-2 overflow-auto max-h-40">
              <pre className="p-2 text-xs">{JSON.stringify(liveResults, null, 2)}</pre>
            </div>
          </div>
        </div>
      </CardContent>
      <CardFooter>
        <div className="text-sm text-muted-foreground">
          {isLiveActive ? 
            'Live query is active. Changes to the data will update automatically.' : 
            'Start a live query to see real-time updates.'}
        </div>
      </CardFooter>
    </Card>
  );
} 