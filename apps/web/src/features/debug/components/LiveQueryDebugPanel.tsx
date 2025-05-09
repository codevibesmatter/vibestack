import React, { useState, useEffect, useMemo } from 'react';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { usePGliteContext } from '@/db/pglite-provider';
import { Task, Project, User, Comment, TaskStatus, TaskPriority, ProjectStatus } from '@repo/dataforge/client-entities';
import { useLiveEntity } from '@/db/hooks/useLiveEntity';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
// Temporarily comment out the LiveQueryTester import until you create this component
// import { LiveQueryTester } from './LiveQueryTester';
import { SyncManager } from '@/sync/SyncManager';
import { TableChange } from '@repo/sync-types';
import { Textarea } from '@/components/ui/textarea';
import { v4 as uuidv4 } from 'uuid';
import { Label } from '@/components/ui/label';
import { getNewPGliteDataSource } from '@/db/newtypeorm/NewDataSource';
import { SelectQueryBuilder } from 'typeorm';

export function LiveQueryDebugPanel() {
  // State for test selection
  const [activeTab, setActiveTab] = useState<string>('tasks');
  
  // State for tracking changes
  const [changeHistory, setChangeHistory] = useState<any[]>([]);
  
  // New state for SyncChangeManager test
  const [syncChangeJson, setSyncChangeJson] = useState<string>(`{
  "table": "tasks",
  "operation": "insert",
  "data": {
    "id": "${uuidv4()}",
    "title": "Sync Test Task",
    "description": "Created via SyncChangeManager",
    "status": "${TaskStatus.OPEN}",
    "priority": "${TaskPriority.MEDIUM}",
    "created_at": "${new Date().toISOString()}",
    "updated_at": "${new Date().toISOString()}"
  }
}`);
  const [syncChangeResult, setSyncChangeResult] = useState<string>('');
  const [isSyncProcessing, setIsSyncProcessing] = useState(false);
  const [dataSourceError, setDataSourceError] = useState<string | null>(null);
  
  // State for query builders
  const [queryBuilders, setQueryBuilders] = useState<{
    tasks: SelectQueryBuilder<Task> | null;
    projects: SelectQueryBuilder<Project> | null;
    users: SelectQueryBuilder<User> | null;
    comments: SelectQueryBuilder<Comment> | null;
  }>({
    tasks: null,
    projects: null,
    users: null,
    comments: null
  });
  
  // Get repositories and services from context
  const { repositories, services } = usePGliteContext();
  
  // Initialize query builders using service methods
  useEffect(() => {
    const initializeQueryBuilders = async () => {
      try {
        if (!services) {
          throw new Error('Services not available in context');
        }
        
        // Get a new data source to create query builders from service methods
        const dataSource = await getNewPGliteDataSource();
        
        if (!dataSource.isInitialized) {
          console.log('DataSource not initialized, initializing...');
          await dataSource.initialize();
        }
        
        // Create query builders for each entity using the repositories
        // These query builders will be used by the useLiveEntity hook to watch for changes
        // made via the service methods
        const tasksQB = dataSource.getRepository(Task).createQueryBuilder("task")
          .orderBy("task.updatedAt", "DESC")
          .limit(20);
          
        const projectsQB = dataSource.getRepository(Project).createQueryBuilder("project")
          .orderBy("project.updatedAt", "DESC")
          .limit(20);
          
        const usersQB = dataSource.getRepository(User).createQueryBuilder("user")
          .orderBy("user.updatedAt", "DESC")
          .limit(20);
          
        const commentsQB = dataSource.getRepository(Comment).createQueryBuilder("comment")
          .orderBy("comment.updatedAt", "DESC")
          .limit(20);
          
        setQueryBuilders({
          tasks: tasksQB,
          projects: projectsQB,
          users: usersQB,
          comments: commentsQB
        });
        
        console.log('Query builders initialized successfully - watching for service method changes');
        setDataSourceError(null);
      } catch (error) {
        console.error('Error initializing query builders:', error);
        setDataSourceError(error instanceof Error ? error.message : String(error));
      }
    };
    
    initializeQueryBuilders();
  }, [services]);
  
  // Select the right query builder based on active tab
  const currentQueryBuilder = useMemo(() => {
    return queryBuilders[activeTab as keyof typeof queryBuilders] || null;
  }, [activeTab, queryBuilders]);
  
  // Use live entity hook for the selected entity type
  const { 
    data: liveData, 
    loading: isLoading, 
    error 
  } = useLiveEntity<any>(
    currentQueryBuilder,
    { enabled: !!currentQueryBuilder }
  );
  
  // Log the received data for debugging
  useEffect(() => {
    if (liveData && liveData.length > 0) {
      console.log('Received live data:', JSON.stringify(liveData[0], null, 2));
    }
  }, [liveData]);
  
  // Track changes to data
  useEffect(() => {
    if (liveData && liveData.length > 0) {
      const now = Date.now();
      
      setChangeHistory(prev => {
        const timeSinceLastUpdate = prev.length > 0 ? now - prev[0].timestamp : 0;
        
        return [
          {
            timestamp: now,
            millisSinceLastUpdate: timeSinceLastUpdate,
            table: activeTab,
            recordCount: liveData.length,
            firstRecordId: liveData[0]?.id || liveData[0]?.task_id || null
          },
          ...prev.slice(0, 19) // Keep last 20 changes
        ];
      });
    }
  }, [liveData, activeTab]);
  
  // Test function for SyncChangeManager
  const testSyncChangeManager = async () => {
    try {
      setIsSyncProcessing(true);
      setSyncChangeResult('Processing...');
      
      // First, try to use the appropriate service method if available
      const parsedChange = JSON.parse(syncChangeJson);
      const singleChange = Array.isArray(parsedChange) ? parsedChange[0] : parsedChange;
      
      const startTime = Date.now();
      let result = false;
      let usingService = false;
      
      // Try to use service methods first if appropriate
      if (singleChange.table === 'tasks' && singleChange.operation === 'insert' && services?.tasks) {
        try {
          console.log('[LiveQueryDebug] Using TaskService for task insert');
          const task = await services.tasks.createFromSync(singleChange.data);
          console.log('[LiveQueryDebug] Task created via service:', task);
          result = true;
          usingService = true;
        } catch (serviceError) {
          console.error('Error using TaskService for sync test, falling back to SyncChangeManager:', serviceError);
        }
      } else if (singleChange.table === 'projects' && singleChange.operation === 'insert' && services?.projects) {
        try {
          console.log('[LiveQueryDebug] Using ProjectService for project insert');
          const project = await services.projects.createFromSync(singleChange.data);
          console.log('[LiveQueryDebug] Project created via service:', project);
          result = true;
          usingService = true;
        } catch (serviceError) {
          console.error('Error using ProjectService for sync test, falling back to SyncChangeManager:', serviceError);
        }
      }
      
      // If service method wasn't used, fall back to IncomingChangeProcessor
      if (!usingService) {
        console.log('[LiveQueryDebug] Using IncomingChangeProcessor via SyncManager');
        // Get SyncManager instance
        const syncManager = SyncManager.getInstance();
        // Get IncomingChangeProcessor
        const incomingChangeProcessor = syncManager.getIncomingChangeProcessor();
        
        // Process the changes
        const changes: TableChange[] = Array.isArray(parsedChange) ? parsedChange : [parsedChange];
        result = await incomingChangeProcessor.processIncomingChanges(changes, 'debug_panel_test');
      }
      
      const duration = Date.now() - startTime;
      
      // Update result
      setSyncChangeResult(
        `Result: ${result ? 'Success' : 'Failed'}\n` +
        `Duration: ${duration}ms\n` +
        `Method: ${usingService ? 'Service API' : 'IncomingChangeProcessor (via SyncManager)'}\n` +
        `Table: ${singleChange.table}\n` +
        `Operation: ${singleChange.operation}`
      );
      
      // Generate a fresh UUID for the next test
      const freshJson = syncChangeJson.replace(
        /"id":\s*"([^"]+)"/,
        `"id": "${uuidv4()}"`
      );
      setSyncChangeJson(freshJson);
      
    } catch (error) {
      setSyncChangeResult(`Error: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsSyncProcessing(false);
    }
  };
  
  // Generate task change template
  const generateTaskChange = () => {
    const newTaskId = uuidv4();
    const now = new Date().toISOString();
    setSyncChangeJson(`{
  "table": "tasks",
  "operation": "insert",
  "data": {
    "id": "${newTaskId}",
    "title": "Sync Test Task ${newTaskId.substring(0, 6)}",
    "description": "Created via SyncChangeManager",
    "status": "${TaskStatus.OPEN}",
    "priority": "${TaskPriority.MEDIUM}",
    "created_at": "${now}",
    "updated_at": "${now}"
  }
}`);
  };
  
  // Generate project change template
  const generateProjectChange = () => {
    const newProjectId = uuidv4();
    const now = new Date().toISOString();
    setSyncChangeJson(`{
  "table": "projects",
  "operation": "insert",
  "data": {
    "id": "${newProjectId}",
    "name": "Sync Test Project ${newProjectId.substring(0, 6)}",
    "description": "Created via SyncChangeManager",
    "status": "${ProjectStatus.ACTIVE}",
    "created_at": "${now}",
    "updated_at": "${now}"
  }
}`);
  };
  
  // Create a new task using the service method - this should trigger a live query update
  const createTestTask = async () => {
    if (!services?.tasks) {
      console.error('Task service not available');
      return;
    }
    
    try {
      console.log('[LiveQueryDebug] Creating test task using TaskService.createTask()');
      const projects = await services.projects.getAll();
      
      if (!projects.length) {
        console.warn('No projects found, creating a project first');
        await createTestProject();
        const projects = await services.projects.getAll();
        if (!projects.length) {
          console.error('Failed to create a project, cannot create task');
          return;
        }
      }
      
      const newTask = await services.tasks.createTask({
        title: `Test Task ${Date.now()}`,
        description: 'Created from Live Query Debug using service method',
        projectId: projects[0]?.id,
      });
      
      console.log('[LiveQueryDebug] Created test task via service:', newTask);
      console.log('[LiveQueryDebug] Watching for live query update...');
    } catch (error) {
      console.error('Error creating test task via service:', error);
    }
  };
  
  // Create a test project using the service method - this should trigger a live query update
  const createTestProject = async () => {
    if (!services?.projects) {
      console.error('Project service not available');
      return;
    }
    
    try {
      console.log('[LiveQueryDebug] Creating test project using ProjectService.createProject()');
      const newProject = await services.projects.createProject({
        name: `Test Project ${Date.now()}`,
        description: 'Created from Live Query Debug using service method',
      });
      
      console.log('[LiveQueryDebug] Created test project via service:', newProject);
      console.log('[LiveQueryDebug] Watching for live query update...');
    } catch (error) {
      console.error('Error creating test project via service:', error);
    }
  };
  
  // Update a random record using the service method - this should trigger a live query update
  const updateRandomRecord = async () => {
    if (!liveData || liveData.length === 0) {
      console.warn('No data available to update');
      return;
    }
    
    const randomIndex = Math.floor(Math.random() * liveData.length);
    const recordToUpdate = liveData[randomIndex];
    
    // Fix: Use the correct ID field format (task_id instead of tasks_id)
    const idField = activeTab.endsWith('s') 
      ? activeTab.substring(0, activeTab.length - 1) + '_id' 
      : activeTab + '_id';
    const recordId = getProperty(recordToUpdate, 'id', idField);
    
    if (!recordId) {
      console.error('Failed to get ID from record', recordToUpdate);
      return;
    }
    
    try {
      console.log(`[LiveQueryDebug] Updating ${activeTab} with ID: ${recordId}`);
      
      switch (activeTab) {
        case 'tasks':
          if (services?.tasks) {
            await services.tasks.updateTask(recordId, {
              title: `Updated Task ${Date.now()}`,
              description: 'Updated via service method'
            });
            console.log('[LiveQueryDebug] Updated task via TaskService.updateTask()');
          }
          break;
          
        case 'projects':
          if (services?.projects) {
            await services.projects.updateProject(recordId, {
              name: `Updated Project ${Date.now()}`,
              description: 'Updated via service method'
            });
            console.log('[LiveQueryDebug] Updated project via ProjectService.updateProject()');
          }
          break;
          
        // Add other entity types as needed
      }
      
      console.log(`[LiveQueryDebug] Updated ${activeTab} via service method, watching for live query update...`);
    } catch (error) {
      console.error(`Error updating ${activeTab} via service:`, error);
    }
  };
  
  // Delete a random record using the service method - this should trigger a live query update
  const deleteRandomRecord = async () => {
    if (!liveData || liveData.length === 0) {
      console.warn('No data available to delete');
      return;
    }
    
    const randomIndex = Math.floor(Math.random() * liveData.length);
    const recordToDelete = liveData[randomIndex];
    
    // Fix: Use the correct ID field format (task_id instead of tasks_id)
    const idField = activeTab.endsWith('s') 
      ? activeTab.substring(0, activeTab.length - 1) + '_id' 
      : activeTab + '_id';
    const recordId = getProperty(recordToDelete, 'id', idField);
    
    if (!recordId) {
      console.error('Failed to get ID from record', recordToDelete);
      return;
    }
    
    try {
      console.log(`[LiveQueryDebug] Deleting ${activeTab} with ID: ${recordId}`);
      
      switch (activeTab) {
        case 'tasks':
          if (services?.tasks) {
            await services.tasks.deleteTask(recordId);
            console.log('[LiveQueryDebug] Deleted task via TaskService.deleteTask()');
          }
          break;
          
        case 'projects':
          if (services?.projects) {
            await services.projects.deleteProject(recordId);
            console.log('[LiveQueryDebug] Deleted project via ProjectService.deleteProject()');
          }
          break;
          
        // Add other entity types as needed
      }
      
      console.log(`[LiveQueryDebug] Deleted ${activeTab} via service method, watching for live query update...`);
    } catch (error) {
      console.error(`Error deleting ${activeTab} via service:`, error);
    }
  };
  
  // Helper function to access properties from either camelCase or snake_case format
  const getProperty = (obj: any, camelCaseProp: string, snakeCaseProp: string) => {
    if (!obj) return null;
    
    // Try camelCase first
    if (obj[camelCaseProp] !== undefined) {
      return obj[camelCaseProp];
    }
    
    // Try snake_case next
    if (obj[snakeCaseProp] !== undefined) {
      return obj[snakeCaseProp];
    }
    
    return null;
  };
  
  // Helper function to get date value and convert to locale string
  const getDateString = (obj: any, camelCaseProp: string, snakeCaseProp: string) => {
    const dateValue = getProperty(obj, camelCaseProp, snakeCaseProp);
    
    if (!dateValue) return 'N/A';
    
    if (dateValue instanceof Date) {
      return dateValue.toLocaleString();
    }
    
    // Try to convert string to Date
    try {
      return new Date(dateValue).toLocaleString();
    } catch (e) {
      return 'Invalid Date';
    }
  };
  
  // If there's an error initializing the DataSource
  if (dataSourceError) {
    return (
      <div className="space-y-6">
        {/* Commented out until LiveQueryTester is implemented */}
        {/* <LiveQueryTester /> */}
        <Alert variant="destructive">
          <AlertTitle>Error Initializing TypeORM DataSource</AlertTitle>
          <AlertDescription>{dataSourceError}</AlertDescription>
        </Alert>
      </div>
    );
  }
  
  return (
    <div className="space-y-6">
      {/* Add the LiveQueryTester at the top - commented out until implemented */}
      {/* <LiveQueryTester /> */}
      
      {/* SyncChangeManager Test */}
      <Card>
        <CardHeader>
          <CardTitle>SyncChangeManager Test</CardTitle>
          <CardDescription>
            Test if changes processed through SyncChangeManager trigger live query updates
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="sync-change-json">TableChange JSON</Label>
            <Textarea
              id="sync-change-json"
              value={syncChangeJson}
              onChange={(e) => setSyncChangeJson(e.target.value)}
              className="font-mono h-40"
            />
          </div>
          
          <div className="flex flex-wrap space-x-2">
            <Button 
              onClick={testSyncChangeManager} 
              disabled={isSyncProcessing}
            >
              Process Changes
            </Button>
            <Button onClick={generateTaskChange} variant="outline">
              Task Template
            </Button>
            <Button onClick={generateProjectChange} variant="outline">
              Project Template
            </Button>
          </div>
          
          {syncChangeResult && (
            <div className="mt-4">
              <div className="text-sm font-medium">Result:</div>
              <pre className="bg-muted p-2 rounded text-xs overflow-auto mt-1 max-h-40">
                {syncChangeResult}
              </pre>
            </div>
          )}
        </CardContent>
      </Card>
      
      {/* Entity Select Tabs */}
      <Tabs defaultValue="tasks" value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="tasks">Tasks</TabsTrigger>
          <TabsTrigger value="projects">Projects</TabsTrigger>
          <TabsTrigger value="users">Users</TabsTrigger>
          <TabsTrigger value="comments">Comments</TabsTrigger>
        </TabsList>
        
        {/* Tasks Content */}
        <TabsContent value="tasks">
          <Card>
            <CardHeader>
              <CardTitle>Live Tasks</CardTitle>
              <CardDescription>
                Real-time tasks data using Live Queries. Any changes to the tasks table will appear instantly.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <div className="py-8 text-center">Loading tasks...</div>
              ) : error ? (
                <Alert variant="destructive">
                  <AlertTitle>Error</AlertTitle>
                  <AlertDescription>{error.message}</AlertDescription>
                </Alert>
              ) : (
                <div className="border rounded-md">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b bg-muted/50">
                        <th className="p-2 text-left">ID</th>
                        <th className="p-2 text-left">Title</th>
                        <th className="p-2 text-left">Status</th>
                        <th className="p-2 text-left">Updated</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(liveData as any[] || []).map((task, index) => (
                        <tr key={getProperty(task, 'id', 'task_id') || index} className="border-b">
                          <td className="p-2">
                            {getProperty(task, 'id', 'task_id') 
                              ? String(getProperty(task, 'id', 'task_id')).substring(0, 8) + '...' 
                              : 'N/A'}
                          </td>
                          <td className="p-2">{getProperty(task, 'title', 'task_title') || 'N/A'}</td>
                          <td className="p-2">{getProperty(task, 'status', 'task_status') || 'N/A'}</td>
                          <td className="p-2">{getDateString(task, 'updatedAt', 'task_updated_at')}</td>
                        </tr>
                      ))}
                      {(!liveData || liveData.length === 0) && (
                        <tr>
                          <td colSpan={4} className="p-4 text-center">No tasks found</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
            <CardFooter className="flex justify-between">
              <Button onClick={createTestTask}>Create Test Task</Button>
              <Button onClick={updateRandomRecord} disabled={!liveData || liveData.length === 0}>
                Update Random Task
              </Button>
              <Button 
                onClick={deleteRandomRecord} 
                variant="destructive" 
                disabled={!liveData || liveData.length === 0}
              >
                Delete Random Task
              </Button>
            </CardFooter>
          </Card>
        </TabsContent>
        
        {/* Projects Content */}
        <TabsContent value="projects">
          <Card>
            <CardHeader>
              <CardTitle>Live Projects</CardTitle>
              <CardDescription>
                Real-time projects data using Live Queries. Any changes to the projects table will appear instantly.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <div className="py-8 text-center">Loading projects...</div>
              ) : error ? (
                <Alert variant="destructive">
                  <AlertTitle>Error</AlertTitle>
                  <AlertDescription>{error.message}</AlertDescription>
                </Alert>
              ) : (
                <div className="border rounded-md">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b bg-muted/50">
                        <th className="p-2 text-left">ID</th>
                        <th className="p-2 text-left">Name</th>
                        <th className="p-2 text-left">Description</th>
                        <th className="p-2 text-left">Updated</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(liveData as any[] || []).map((project, index) => (
                        <tr key={getProperty(project, 'id', 'project_id') || index} className="border-b">
                          <td className="p-2">
                            {getProperty(project, 'id', 'project_id') 
                              ? String(getProperty(project, 'id', 'project_id')).substring(0, 8) + '...' 
                              : 'N/A'}
                          </td>
                          <td className="p-2">{getProperty(project, 'name', 'project_name') || 'N/A'}</td>
                          <td className="p-2">{getProperty(project, 'description', 'project_description') || 'N/A'}</td>
                          <td className="p-2">{getDateString(project, 'updatedAt', 'project_updated_at')}</td>
                        </tr>
                      ))}
                      {(!liveData || liveData.length === 0) && (
                        <tr>
                          <td colSpan={4} className="p-4 text-center">No projects found</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
            <CardFooter className="flex justify-between">
              <Button onClick={createTestProject}>Create Test Project</Button>
              <Button onClick={updateRandomRecord} disabled={!liveData || liveData.length === 0}>
                Update Random Project
              </Button>
              <Button 
                onClick={deleteRandomRecord} 
                variant="destructive" 
                disabled={!liveData || liveData.length === 0}
              >
                Delete Random Project
              </Button>
            </CardFooter>
          </Card>
        </TabsContent>
        
        {/* Other entity tabs would follow the same pattern */}
        <TabsContent value="users">
          <Card>
            <CardHeader>
              <CardTitle>Live Users</CardTitle>
              <CardDescription>
                Real-time users data using Live Queries.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <div className="py-8 text-center">Loading users...</div>
              ) : error ? (
                <Alert variant="destructive">
                  <AlertTitle>Error</AlertTitle>
                  <AlertDescription>{error.message}</AlertDescription>
                </Alert>
              ) : (
                <div className="border rounded-md">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b bg-muted/50">
                        <th className="p-2 text-left">ID</th>
                        <th className="p-2 text-left">Name</th>
                        <th className="p-2 text-left">Email</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(liveData as any[] || []).map((user, index) => (
                        <tr key={getProperty(user, 'id', 'user_id') || index} className="border-b">
                          <td className="p-2">
                            {getProperty(user, 'id', 'user_id') 
                              ? String(getProperty(user, 'id', 'user_id')).substring(0, 8) + '...' 
                              : 'N/A'}
                          </td>
                          <td className="p-2">{getProperty(user, 'name', 'name') || 'N/A'}</td>
                          <td className="p-2">{getProperty(user, 'email', 'email') || 'N/A'}</td>
                        </tr>
                      ))}
                      {(!liveData || liveData.length === 0) && (
                        <tr>
                          <td colSpan={3} className="p-4 text-center">No users found</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
        
        <TabsContent value="comments">
          <Card>
            <CardHeader>
              <CardTitle>Live Comments</CardTitle>
              <CardDescription>
                Real-time comments data using Live Queries.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <div className="py-8 text-center">Loading comments...</div>
              ) : error ? (
                <Alert variant="destructive">
                  <AlertTitle>Error</AlertTitle>
                  <AlertDescription>{error.message}</AlertDescription>
                </Alert>
              ) : (
                <div className="border rounded-md">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b bg-muted/50">
                        <th className="p-2 text-left">ID</th>
                        <th className="p-2 text-left">Content</th>
                        <th className="p-2 text-left">Created</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(liveData as any[] || []).map((comment, index) => (
                        <tr key={getProperty(comment, 'id', 'comment_id') || index} className="border-b">
                          <td className="p-2">
                            {getProperty(comment, 'id', 'comment_id') 
                              ? String(getProperty(comment, 'id', 'comment_id')).substring(0, 8) + '...' 
                              : 'N/A'}
                          </td>
                          <td className="p-2">{getProperty(comment, 'content', 'content') || 'N/A'}</td>
                          <td className="p-2">{getDateString(comment, 'createdAt', 'created_at')}</td>
                        </tr>
                      ))}
                      {(!liveData || liveData.length === 0) && (
                        <tr>
                          <td colSpan={3} className="p-4 text-center">No comments found</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
      
      {/* Live Update Log */}
      <Card>
        <CardHeader>
          <CardTitle>Live Update Log</CardTitle>
          <CardDescription>
            A log of all updates detected by the live query system
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="border rounded-md">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="p-2 text-left">Time</th>
                  <th className="p-2 text-left">MS Since Last</th>
                  <th className="p-2 text-left">Table</th>
                  <th className="p-2 text-left">Records</th>
                  <th className="p-2 text-left">First ID</th>
                </tr>
              </thead>
              <tbody>
                {changeHistory.map((change, index) => (
                  <tr key={index} className="border-b">
                    <td className="p-2">{new Date(change.timestamp).toLocaleTimeString()}</td>
                    <td className="p-2">{change.millisSinceLastUpdate}ms</td>
                    <td className="p-2">{change.table || 'N/A'}</td>
                    <td className="p-2">{change.recordCount || 0}</td>
                    <td className="p-2">{change.firstRecordId ? change.firstRecordId.substring(0, 8) + '...' : 'N/A'}</td>
                  </tr>
                ))}
                {changeHistory.length === 0 && (
                  <tr>
                    <td colSpan={5} className="p-4 text-center">No updates detected yet</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
      
      {/* Debug Information */}
      <Card>
        <CardHeader>
          <CardTitle>Live Query Debug Info</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <div>
              <strong>Current Table:</strong> {activeTab}
            </div>
            <div>
              <strong>Records Loaded:</strong> {liveData?.length || 0}
            </div>
            <div>
              <strong>Loading Status:</strong> {isLoading ? 'Loading...' : 'Loaded'}
            </div>
            <div>
              <strong>Error Status:</strong> {error ? error.message : 'None'}
            </div>
            <div>
              <strong>Update Count:</strong> {changeHistory.length}
            </div>
            <div>
              <strong>Data Structure:</strong>
              <pre className="bg-muted p-2 rounded text-xs overflow-auto mt-2">
                {liveData && liveData.length > 0 
                  ? JSON.stringify(liveData[0], null, 2) 
                  : 'No data available'}
              </pre>
            </div>
            <div>
              <strong>SQL Query:</strong>
              <pre className="bg-muted p-2 rounded text-xs overflow-auto mt-2">
                {currentQueryBuilder?.getSql() || 'No query builder available'}
              </pre>
            </div>
            <div>
              <strong>Query Parameters:</strong>
              <pre className="bg-muted p-2 rounded text-xs overflow-auto mt-2">
                {JSON.stringify(currentQueryBuilder?.getParameters() || {}, null, 2)}
              </pre>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
} 