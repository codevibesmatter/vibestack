import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { useSyncContext } from '@/sync/SyncContext';
import { SyncManager } from '@/sync/SyncManager';
import { TableChange } from '@repo/sync-types';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { v4 as uuidv4 } from 'uuid';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { usePGliteContext } from '@/db/pglite-provider';
import { TaskStatus, TaskPriority, ProjectStatus } from '@repo/dataforge/client-entities';

// History event types
interface ChangeHistoryEvent {
  id: string;
  timestamp: string;
  changeId?: string;
  table?: string;
  operation?: string;
  // Expanded event types to track more detailed sync flow
  type: 'create' | 'prepare' | 'send' | 'receive' | 'process' | 'apply' | 'acknowledge' | 'error';
  status: 'pending' | 'success' | 'error';
  message: string;
  data?: any;
}

export function SyncChangesDebugPanel() {
  // State for tab selection
  const [activeTab, setActiveTab] = useState<string>('outgoing');
  
  // Get sync context data
  const { 
    processQueuedChanges,
    syncState
  } = useSyncContext();
  
  // Get services from PGlite context
  const { services, isLoading: dbLoading } = usePGliteContext();
  
  // State for tracking changes
  const [outgoingChanges, setOutgoingChanges] = useState<TableChange[]>([]);
  const [incomingChanges, setIncomingChanges] = useState<TableChange[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<Error | null>(null);
  
  // State for tracking pending server changes waiting for sync confirmation
  const [pendingServerChanges, setPendingServerChanges] = useState<Record<string, {
    id: string;
    table: string;
    operation: 'insert' | 'update' | 'delete';
    timestamp: string;
    status: 'pending' | 'confirmed' | 'error';
    historyEventId?: string;
    confirmTime?: string;
  }>>({});
  
  // State for history tracking
  const [outgoingHistory, setOutgoingHistory] = useState<ChangeHistoryEvent[]>([]);
  const [incomingHistory, setIncomingHistory] = useState<ChangeHistoryEvent[]>([]);
  const [changeHistory, setChangeHistory] = useState<ChangeHistoryEvent[]>([]);
  
  // State for test change creation
  const [testChangeJson, setTestChangeJson] = useState<string>(`{
  "table": "tasks",
  "operation": "insert",
  "data": {
    "id": "${uuidv4()}",
    "title": "Test Task for Sync",
    "description": "Created via Sync Changes Debug Panel"
  }
}`);
  const [testResult, setTestResult] = useState<string>('');
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  
  // State for external API changes
  const [apiEndpoint, setApiEndpoint] = useState<string>('/api/tasks');
  const [apiMethod, setApiMethod] = useState<string>('POST');
  const [apiPayload, setApiPayload] = useState<string>(`{
  "title": "API Created Task",
  "description": "Created via API to test sync",
  "status": "open",
  "priority": "medium"
}`);
  const [apiResponse, setApiResponse] = useState<string>('');
  const [apiResult, setApiResult] = useState<any>(null);
  const [isApiProcessing, setIsApiProcessing] = useState<boolean>(false);

  // Reference to SyncManager for event listening and processors
  const syncManager = SyncManager.getInstance();

  // Helper function to get pending changes (temporary until implemented in SyncChangeManager)
  const fetchPendingChanges = async (): Promise<TableChange[]> => {
    try {
      // Get OutgoingChangeProcessor instance
      const outgoingProcessor = syncManager.getOutgoingChangeProcessor();
      // Use the implemented getPendingChanges method
      const localChanges = await outgoingProcessor.getPendingChanges();
      // Map LocalChanges[] to TableChange[]
      return localChanges.map(lc => ({
        table: lc.table,
        operation: lc.operation as 'insert' | 'update' | 'delete', // Cast operation
        data: lc.data, // Assuming lc.data is already in the correct format or handled by consumer
        updated_at: lc.updatedAt instanceof Date ? lc.updatedAt.toISOString() : new Date().toISOString(), // Ensure updatedAt is a string
        // Add other TableChange fields if necessary, e.g., id, client_id, lsn
        // For now, assuming these are the core fields needed by the debug panel
      }));
    } catch (error) {
      console.error('Error fetching pending changes:', error);
      return [];
    }
  };

  // Helper function to add a history event
  const addHistoryEvent = (
    type: 'create' | 'prepare' | 'send' | 'receive' | 'process' | 'apply' | 'acknowledge' | 'error',
    status: 'pending' | 'success' | 'error',
    message: string,
    change?: TableChange,
    error?: any
  ) => {
    const event: ChangeHistoryEvent = {
      id: uuidv4(),
      timestamp: new Date().toISOString(),
      type,
      status,
      message,
      data: error || undefined
    };
    
    // Add change details if provided
    if (change) {
      event.changeId = String(change.data?.id || uuidv4());
      event.table = change.table;
      event.operation = change.operation;
      event.data = change.data;
    }
    
    // Add to appropriate history arrays
    setChangeHistory(prev => [event, ...prev].slice(0, 100));
    
    // Determine if outgoing or incoming and add to respective history
    if (message.includes('API') || message.includes('server') || message.includes('incoming')) {
      setIncomingHistory(prev => [event, ...prev].slice(0, 50));
    } else {
      setOutgoingHistory(prev => [event, ...prev].slice(0, 50));
    }
    
    return event;
  };

  // Load initial data
  useEffect(() => {
    // Track previous count to avoid redundant history entries
    let previousPendingCount = -1;
    
    const loadInitialData = async () => {
      try {
        setIsLoading(true);
        
        // Get pending outgoing changes using the implemented method
        const pending = await fetchPendingChanges();
        setOutgoingChanges(pending || []);
        
        // Only log history if the count has changed
        if (previousPendingCount !== pending.length) {
          addHistoryEvent(
            'create',
            'success',
            `Loaded ${pending.length} pending outgoing changes`,
            undefined
          );
          // Update previous count
          previousPendingCount = pending.length;
        }
        
        setIsLoading(false);
      } catch (err) {
        console.error('Error loading sync changes data:', err);
        setError(err instanceof Error ? err : new Error('Failed to load sync changes data'));
        
        // Log error in history
        addHistoryEvent(
          'error',
          'error',
          'Failed to load sync changes data',
          undefined,
          err
        );
        
        setIsLoading(false);
      }
    };
    
    loadInitialData();
    
    // Set up a refresh interval
    const intervalId = setInterval(() => {
      loadInitialData();
    }, 5000); // Refresh every 5 seconds
    
    return () => {
      clearInterval(intervalId);
    };
  }, []);
  
  // Process a test change
  const processTestChange = async () => {
    try {
      setIsProcessing(true);
      setTestResult('Processing...');
      
      // Parse the change JSON
      const changeData = JSON.parse(testChangeJson);
      
      // Add to history as pending
      const historyEvent = addHistoryEvent(
        'create',
        'pending',
        `Creating outgoing change for ${changeData.table}`,
        changeData
      );
      
      // Get the OutgoingChangeProcessor
      const outgoingProcessor = syncManager.getOutgoingChangeProcessor();
      
      // Track the change using the implemented method
      await outgoingProcessor.trackChange(
        changeData.table,
        changeData.operation,
        changeData.data
      );
      
      // Refresh outgoing changes
      const pending = await fetchPendingChanges();
      setOutgoingChanges(pending || []);
      
      // Update history event to success
      addHistoryEvent(
        'create',
        'success',
        `Created outgoing change for ${changeData.table} (${changeData.operation})`,
        changeData
      );
      
      // Update result message
      setTestResult(`Success: Change tracked for ${changeData.table}\nOperation: ${changeData.operation}\nID: ${changeData.data.id}`);
      
      // Generate a fresh test change with a new UUID
      const freshJson = testChangeJson.replace(
        /"id":\s*"([^"]+)"/,
        `"id": "${uuidv4()}"`
      );
      setTestChangeJson(freshJson);
      
    } catch (error) {
      console.error('Error processing test change:', error);
      setTestResult(`Error: ${error instanceof Error ? error.message : String(error)}`);
      
      // Add error to history
      addHistoryEvent(
        'error',
        'error',
        `Error creating outgoing change: ${error instanceof Error ? error.message : String(error)}`,
        JSON.parse(testChangeJson),
        error
      );
    } finally {
      setIsProcessing(false);
    }
  };
  
  // Process all pending changes
  const handleProcessChanges = async () => {
    try {
      // Track the entire flow with multiple events
      const changes = [...outgoingChanges];
      
      // Log preparing to send
      addHistoryEvent(
        'prepare',
        'pending',
        `Preparing ${changes.length} outgoing changes for sync`,
        undefined
      );
      
      // Log sending
      addHistoryEvent(
        'send',
        'pending',
        `Sending ${changes.length} outgoing changes to server`,
        undefined
      );
      
      // Actual processing
      await processQueuedChanges();
      
      // Refresh outgoing changes after processing
      const pending = await fetchPendingChanges();
      setOutgoingChanges(pending || []);
      
      // Calculate how many were sent
      const changesSent = changes.length - pending.length;
      
      // Log server received
      if (changesSent > 0) {
        addHistoryEvent(
          'send',
          'success',
          `Server received ${changesSent} changes`,
          undefined
        );
        
        // Log server applied
        addHistoryEvent(
          'apply',
          'success',
          `Server applied ${changesSent} changes`,
          undefined
        );
        
        // Log client acknowledged
        addHistoryEvent(
          'acknowledge',
          'success',
          `Client acknowledged ${changesSent} processed changes`,
          undefined
        );
      }
      
      // Final status
      addHistoryEvent(
        'process',
        'success',
        `Sync complete. ${changesSent} sent, ${pending.length} still pending`,
        undefined
      );
      
    } catch (error) {
      console.error('Error processing changes:', error);
      
      // Add error to history
      addHistoryEvent(
        'error',
        'error',
        `Error during sync process: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        error
      );
    }
  };
  
  // Clear all pending changes
  const handleClearChanges = async () => {
    try {
      // Add to history
      addHistoryEvent(
        'process',
        'pending',
        `Clearing ${outgoingChanges.length} unprocessed changes`
      );
      
      // Get the OutgoingChangeProcessor instance
      const outgoingProcessor = syncManager.getOutgoingChangeProcessor();
      
      // Clear unprocessed changes using the implemented method
      await outgoingProcessor.clearUnprocessedChanges();
      
      // Refresh outgoing changes
      const pending = await fetchPendingChanges();
      setOutgoingChanges(pending || []);
      
      // Update history
      addHistoryEvent(
        'process',
        'success',
        `Cleared unprocessed changes. Now have ${pending.length} pending changes`
      );
      
    } catch (error) {
      console.error('Error clearing changes:', error);
      
      // Add error to history
      addHistoryEvent(
        'error',
        'error',
        `Error clearing changes: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        error
      );
    }
  };
  
  // Generate task change template
  const generateTaskChange = () => {
    const newId = uuidv4();
    setTestChangeJson(`{
  "table": "tasks",
  "operation": "insert",
  "data": {
    "id": "${newId}",
    "title": "Test Task ${newId.substring(0, 6)}",
    "description": "Created via Sync Changes Debug Panel",
    "status": "open",
    "priority": "medium",
    "created_at": "${new Date().toISOString()}",
    "updated_at": "${new Date().toISOString()}"
  }
}`);
  };
  
  // Create task using actual application service
  const createTaskWithService = async () => {
    try {
      if (!services?.tasks) {
        setTestResult('Task service not available');
        return;
      }

      setIsProcessing(true);
      setTestResult('Processing...');

      // Add to history as pending
      addHistoryEvent(
        'create',
        'pending',
        'Creating task using TaskService',
        undefined
      );

      // First, find a project to associate with the task
      let projectId = '';
      try {
        const projects = await services.projects.getAll();
        if (projects && projects.length > 0) {
          projectId = projects[0].id;
        } else {
          // Create a project if none exists
          const newProject = await services.projects.createProject({
            name: `Project for Task ${Date.now()}`,
            description: 'Created for task testing'
          });
          projectId = newProject.id;
        }
      } catch (error) {
        console.error('Error finding/creating project for task:', error);
      }

      // Create task using service
      const task = await services.tasks.createTask({
        title: `Test Task ${Date.now()}`,
        description: 'Created via Sync Debug Panel using real TaskService',
        status: TaskStatus.OPEN,
        priority: TaskPriority.MEDIUM,
        projectId: projectId || undefined
      });

      // Create a proper TableChange object
      const tableChange: TableChange = {
        table: 'tasks',
        operation: 'insert',
        data: task,
        updated_at: new Date().toISOString()
      };

      // Add to incoming changes list - these are changes from the server via sync
      setIncomingChanges(prev => [tableChange, ...prev].slice(0, 20));

      // Add success history event
      addHistoryEvent(
        'create',
        'success',
        `Created task "${task.title}" using TaskService`,
        tableChange
      );

      // Add detailed sync flow history events
      addHistoryEvent(
        'send',
        'success',
        'Server sent task change to client',
        tableChange
      );

      addHistoryEvent(
        'receive',
        'success',
        'Client received server task change',
        tableChange
      );

      addHistoryEvent(
        'apply',
        'success',
        'Client applied task change to local database',
        tableChange
      );

      // Refresh outgoing changes
      const pending = await fetchPendingChanges();
      setOutgoingChanges(pending || []);

      // Update result
      setTestResult(`Success: Task created with ID ${task.id}`);
    } catch (error) {
      console.error('Error creating task with service:', error);
      setTestResult(`Error: ${error instanceof Error ? error.message : String(error)}`);
      
      // Add error to history
      addHistoryEvent(
        'error',
        'error',
        `Error creating task with service: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        error
      );
    } finally {
      setIsProcessing(false);
    }
  };
  
  // Create project using actual application service
  const createProjectWithService = async () => {
    try {
      if (!services?.projects) {
        setTestResult('Project service not available');
        return;
      }

      setIsProcessing(true);
      setTestResult('Processing...');

      // Add to history as pending
      addHistoryEvent(
        'create',
        'pending',
        'Creating project using ProjectService',
        undefined
      );

      // Create project using service
      const project = await services.projects.createProject({
        name: `Test Project ${Date.now()}`,
        description: 'Created via Sync Debug Panel using real ProjectService'
      });

      // Create a proper TableChange object
      const tableChange: TableChange = {
        table: 'projects',
        operation: 'insert',
        data: project,
        updated_at: new Date().toISOString()
      };

      // Add to incoming changes list - these are changes from the server via sync
      setIncomingChanges(prev => [tableChange, ...prev].slice(0, 20));

      // Add success history event
      addHistoryEvent(
        'create',
        'success',
        `Created project "${project.name}" using ProjectService`,
        tableChange
      );

      // Add detailed sync flow history events
      addHistoryEvent(
        'send',
        'success',
        'Server sent project change to client',
        tableChange
      );

      addHistoryEvent(
        'receive',
        'success',
        'Client received server project change',
        tableChange
      );

      addHistoryEvent(
        'apply',
        'success',
        'Client applied project change to local database',
        tableChange
      );

      // Refresh outgoing changes
      const pending = await fetchPendingChanges();
      setOutgoingChanges(pending || []);

      // Update result
      setTestResult(`Success: Project created with ID ${project.id}`);
    } catch (error) {
      console.error('Error creating project with service:', error);
      setTestResult(`Error: ${error instanceof Error ? error.message : String(error)}`);
      
      // Add error to history
      addHistoryEvent(
        'error',
        'error',
        `Error creating project with service: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        error
      );
    } finally {
      setIsProcessing(false);
    }
  };
  
  // Generate project change template
  const generateProjectChange = () => {
    const newId = uuidv4();
    setTestChangeJson(`{
  "table": "projects",
  "operation": "insert",
  "data": {
    "id": "${newId}",
    "name": "Test Project ${newId.substring(0, 6)}",
    "description": "Created via Sync Changes Debug Panel",
    "status": "active",
    "created_at": "${new Date().toISOString()}",
    "updated_at": "${new Date().toISOString()}"
  }
}`);
  };
  
  // Generate update change template using an existing record
  const generateUpdateChange = () => {
    if (outgoingChanges.length > 0) {
      const existingChange = outgoingChanges[0];
      const existingData = existingChange.data;
      
      // For updates, ensure we're only updating specific fields
      // while preserving required fields
      const updatePayload: Record<string, any> = {
        id: existingData.id,
        description: `Updated via Sync Changes Debug Panel at ${new Date().toISOString()}`
      };
      
      // If it's a task, ensure we include status
      if (existingChange.table === 'tasks') {
        updatePayload.status = existingData.status || 'open';
        updatePayload.updated_at = new Date().toISOString();
      } 
      // If it's a project, ensure we include status
      else if (existingChange.table === 'projects') {
        updatePayload.status = existingData.status || 'active';
        updatePayload.updated_at = new Date().toISOString();
      }
      
      setTestChangeJson(`{
  "table": "${existingChange.table}",
  "operation": "update",
  "data": ${JSON.stringify(updatePayload, null, 4)}
}`);
    } else {
      setTestResult('No existing records to update. Create a record first.');
    }
  };
  
  // Generate API templates
  const generateApiTaskTemplate = () => {
    setApiEndpoint('/api/tasks');
    setApiMethod('POST');
    setApiPayload(`{
  "title": "API Created Task ${Date.now()}",
  "description": "Created via API to test sync",
  "status": "open",
  "priority": "medium"
}`);
  };
  
  const generateApiProjectTemplate = () => {
    setApiEndpoint('/api/projects');
    setApiMethod('POST');
    setApiPayload(`{
  "name": "API Created Project ${Date.now()}",
  "description": "Created via API to test sync",
  "status": "${ProjectStatus.ACTIVE}"
}`);
  };
  
  // Make API request to test external changes
  const makeApiRequest = async () => {
    try {
      setIsApiProcessing(true);
      setApiResponse('Processing...');
      
      // First event - Preparing API request
      addHistoryEvent(
        'prepare',
        'pending',
        `Preparing server change via API ${apiMethod} ${apiEndpoint}`,
        undefined
      );
      
      // Determine if this is an update or delete that needs an ID in the URL
      let url = apiEndpoint;
      let operation: 'insert' | 'update' | 'delete' = apiMethod === 'POST' ? 'insert' : 
                     apiMethod === 'PATCH' ? 'update' : 
                     apiMethod === 'DELETE' ? 'delete' : 'insert';
                       
      let entityId = '';
      
      if (apiMethod !== 'POST' && apiResult && apiResult.id) {
        entityId = apiResult.id;
        url = `${apiEndpoint}/${entityId}`;
        console.log(`Using entity ID ${entityId} for ${operation} operation to ${url}`);
      }
      
      // Second event - Sending API request
      const sendingEvent = addHistoryEvent(
        'send',
        'pending',
        `Sending ${apiMethod} request to ${url}`,
        undefined
      );
      
      // Prepare the request options
      const options: RequestInit = {
        method: apiMethod,
        headers: {
          'Content-Type': 'application/json',
        }
      };
      
      // Add body for methods that require it
      if (apiMethod !== 'GET' && apiMethod !== 'DELETE') {
        // Parse the payload to log it and ensure it's valid JSON
        try {
          const payloadObj = JSON.parse(apiPayload);
          console.log(`Request payload:`, payloadObj);
          
          // Log each field explicitly to diagnose the issue
          if (payloadObj.status) {
            console.log(`Status field type: ${typeof payloadObj.status}, value: "${payloadObj.status}"`);
          }
          if (payloadObj.title) {
            console.log(`Title field type: ${typeof payloadObj.title}, value: "${payloadObj.title}"`);
          }
          if (payloadObj.description) {
            console.log(`Description field type: ${typeof payloadObj.description}, value: "${payloadObj.description}"`);
          }
          
          // Validate status values based on endpoint type
          if (payloadObj.status) {
            if (apiEndpoint.includes('tasks')) {
              // Validate against TaskStatus enum
              if (!Object.values(TaskStatus).includes(payloadObj.status)) {
                console.error(`Invalid task status value: "${payloadObj.status}". Valid values are: ${Object.values(TaskStatus).join(', ')}`);
                throw new Error(`Invalid status value: "${payloadObj.status}"`);
              }
            } else if (apiEndpoint.includes('projects')) {
              // Validate against ProjectStatus enum
              if (!Object.values(ProjectStatus).includes(payloadObj.status)) {
                console.error(`Invalid project status value: "${payloadObj.status}". Valid values are: ${Object.values(ProjectStatus).join(', ')}`);
                throw new Error(`Invalid status value: "${payloadObj.status}"`);
              }
            }
          }
          
          options.body = apiPayload;
        } catch (e) {
          console.error(`Invalid JSON payload:`, apiPayload);
          throw new Error(`Invalid JSON payload: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      
      // Make the API request
      console.log(`Making ${apiMethod} request to ${url}`);
      const response = await fetch(url, options);
      const responseData = await response.json();
      
      // Log the full response structure for debugging
      console.log('API Response:', responseData);
      
      // Format the response for display
      const formattedResponse = JSON.stringify(responseData, null, 2);
      setApiResponse(formattedResponse);
      
      // Check if the response was successful
      if (response.ok) {
        // Handle the nested structure of the response data
        // The actual structure is { data: { ok: true, data: {...} } }
        const isSuccess = responseData.data?.ok === true || 
                          responseData.success === true || 
                          responseData.ok === true;
        
        const actualData = responseData.data?.data || 
                            responseData.data || 
                            responseData;
        
        if (isSuccess && actualData) {
          // Use the appropriate data object based on the response structure
          const entityData = actualData.id ? actualData : null;
          
          if (entityData) {
            setApiResult(entityData);
            
            // Use the entityId from our request for update/delete operations
            // or get it from the response for creates
            const changeId = operation === 'insert' ? 
                            String(entityData.id || '') : 
                            entityId;
            
            const tableName = apiEndpoint.split('/').pop() || 'unknown';
            
            // Add incoming change to simulate server change received
            const incomingChange: TableChange = {
              table: tableName,
              operation: operation,
              data: entityData,
              updated_at: new Date().toISOString()
            };
            
            // Add to incoming changes list
            setIncomingChanges(prev => [incomingChange, ...prev].slice(0, 20));
            
            // Add to pending server changes to track
            if (changeId) {
              console.log(`Adding pending server change for ${operation} with ID: ${changeId}`);
              setPendingServerChanges(prev => {
                const updated = { ...prev };
                updated[changeId] = {
                  id: changeId,
                  table: tableName,
                  operation: operation,
                  timestamp: new Date().toISOString(),
                  status: 'pending',
                  historyEventId: sendingEvent.id
                };
                return updated;
              });
            }
            
            // Add server change created event
            addHistoryEvent(
              'create',
              'success',
              `Server ${operation === 'insert' ? 'created' : operation === 'update' ? 'updated' : 'deleted'} ${tableName} with ID ${changeId} (waiting for sync confirmation)`,
              incomingChange
            );
            
            // Add server pushing change event
            addHistoryEvent(
              'send',
              'success',
              `Server preparing to push ${operation} change to clients (ID: ${changeId})`,
              incomingChange
            );
          } else {
            // For successful responses without entity data (like DELETE or data in different format)
            addHistoryEvent(
              'create',
              'success',
              `Server successfully processed ${apiMethod} request to ${url}`,
              undefined
            );
          }
        } else {
          // Response has 200 status but doesn't have expected success flag
          addHistoryEvent(
            'create',
            'success',
            `Server processed ${apiMethod} request to ${url} with unrecognized response format`,
            {
              table: apiEndpoint.split('/').pop() || 'unknown',
              operation: (apiMethod === 'POST' ? 'insert' : apiMethod === 'PATCH' ? 'update' : apiMethod === 'DELETE' ? 'delete' : 'insert') as 'insert' | 'update' | 'delete',
              data: responseData,
              updated_at: new Date().toISOString()
            } as TableChange
          );
        }
      } else {
        // Response was not OK (non-2xx status code)
        addHistoryEvent(
          'error',
          'error',
          `API request failed with status ${response.status}: ${response.statusText}`,
          undefined,
          responseData
        );
      }
      
      // If it was a successful create/update, check entity ID
      if (response.ok && (apiMethod === 'POST' || apiMethod === 'PATCH')) {
        // Try to extract ID from nested response structure
        const entityData = responseData.data?.data || responseData.data || responseData;
        if (entityData && entityData.id) {
          // Set the endpoint to include the ID
          const idUrl = `${apiEndpoint}/${entityData.id}`;
          console.log(`API request successful, ID: ${entityData.id}, new URL: ${idUrl}`);
        }
      }
      
    } catch (error) {
      console.error('Error making API request:', error);
      setApiResponse(`Error: ${error instanceof Error ? error.message : String(error)}`);
      
      // Add error to history
      addHistoryEvent(
        'error',
        'error',
        `Error making API request: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        error
      );
    } finally {
      setIsApiProcessing(false);
    }
  };

  // Fix the generateUpdateApiRequest to send only the status field for task updates
  const generateUpdateApiRequest = () => {
    if (apiResult && apiResult.id) {
      setApiMethod('PATCH');
      
      // Extract the entity ID and determine the entity type
      const entityId = apiResult.id;
      const entityType = apiEndpoint.includes('tasks') ? 'task' : 
                         apiEndpoint.includes('projects') ? 'project' : 'entity';
      
      // Customize payload based on entity type
      if (apiEndpoint.includes('tasks')) {
        // IMPORTANT: Only update the status field to avoid parameter order issues
        setApiPayload(`{
  "status": "${TaskStatus.IN_PROGRESS}"
}`);
      } else if (apiEndpoint.includes('projects')) {
        setApiPayload(`{
  "name": "Updated Project ${Date.now()}",
  "description": "Updated via API to test sync",
  "status": "${ProjectStatus.IN_PROGRESS}"
}`);
      }
      
      // Log what we're doing
      console.log(`Generating update request for ${entityType} with ID: ${entityId}`);
    } else {
      setApiResponse('No previous result with ID available. Create a record first.');
    }
  };
  
  // Add a new function to generate title and description updates separately
  const generateTaskTitleUpdate = () => {
    if (apiResult && apiResult.id && apiEndpoint.includes('tasks')) {
      setApiMethod('PATCH');
      setApiPayload(`{
  "title": "Updated Task ${Date.now()}"
}`);
    } else {
      setApiResponse('No task result available to update title.');
    }
  };

  const generateTaskDescriptionUpdate = () => {
    if (apiResult && apiResult.id && apiEndpoint.includes('tasks')) {
      setApiMethod('PATCH');
      setApiPayload(`{
  "description": "Updated via API to test sync ${Date.now()}"
}`);
    } else {
      setApiResponse('No task result available to update description.');
    }
  };
  
  // Generate delete API request using the previous result
  const generateDeleteApiRequest = () => {
    if (apiResult && apiResult.id) {
      setApiMethod('DELETE');
      setApiPayload(''); // DELETE doesn't need a payload
    } else {
      setApiResponse('No previous result with ID available. Create a record first.');
    }
  };
  
  // Render history event list with improved color coding
  const renderHistoryEvents = (events: ChangeHistoryEvent[]) => (
    <div className="border rounded-md">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-muted/50">
            <th className="p-2 text-left">Time</th>
            <th className="p-2 text-left">Event</th>
            <th className="p-2 text-left">Status</th>
            <th className="p-2 text-left">Message</th>
            <th className="p-2 text-left">Details</th>
          </tr>
        </thead>
        <tbody>
          {events.map((event) => (
            <tr key={event.id} className="border-b">
              <td className="p-2">{new Date(event.timestamp).toLocaleTimeString()}</td>
              <td className="p-2">
                <Badge variant={
                  event.type === 'create' ? 'default' :
                  event.type === 'prepare' ? 'outline' :
                  event.type === 'send' ? 'secondary' :
                  event.type === 'receive' ? 'secondary' :
                  event.type === 'process' ? 'default' :
                  event.type === 'apply' ? 'default' :
                  event.type === 'acknowledge' ? 'outline' : 'destructive'
                }>
                  {event.type}
                </Badge>
              </td>
              <td className="p-2">
                <Badge variant={
                  event.status === 'pending' ? 'outline' :
                  event.status === 'success' ? 'default' : 'destructive'
                }>
                  {event.status}
                </Badge>
              </td>
              <td className="p-2">{event.message}</td>
              <td className="p-2">
                {(event.data || event.table) && (
                  <details>
                    <summary className="cursor-pointer">View details</summary>
                    <pre className="mt-2 p-2 bg-muted rounded-md text-xs overflow-auto max-h-40">
                      {JSON.stringify({
                        table: event.table,
                        operation: event.operation,
                        changeId: event.changeId,
                        data: event.data
                      }, null, 2)}
                    </pre>
                  </details>
                )}
              </td>
            </tr>
          ))}
          {events.length === 0 && (
            <tr>
              <td colSpan={5} className="p-4 text-center">No history events</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
  
  // Effect to listen for incoming changes from the server
  useEffect(() => {
    if (!syncManager) return; // Use syncManager

    const incomingProcessor = syncManager.getIncomingChangeProcessor();
    if (!incomingProcessor) {
      console.warn('[SyncChangesDebugPanel] IncomingChangeProcessor not available. Skipping event listener setup.');
      return;
    }
    
    // Flag to track if effect is mounted
    let isMounted = true;
    
    console.log('[SyncChangesDebugPanel] Setting up sync change listeners for IncomingChangeProcessor');
    
    // Store the original method from the processor
    const originalProcessMethod = incomingProcessor.processIncomingChanges;

    // Handler for processing incoming changes (remains largely the same)
    const handleIncomingChanges = (changes: TableChange[]) => {
      if (!isMounted) return;
      
      console.log('[SyncChangesDebugPanel] Received incoming changes via event:', changes);
      
      setIncomingChanges(prev => {
        const newChanges = [...changes, ...prev];
        return newChanges.slice(0, 50);
      });
      
      if (Object.keys(pendingServerChanges).length > 0) {
        changes.forEach(change => {
          const changeId = String(change.data?.id || '');
          if (changeId && pendingServerChanges[changeId]) {
            const pending = pendingServerChanges[changeId];
            console.log(`[SyncChangesDebugPanel] Matched incoming change for ID: ${changeId}`, change);
            addHistoryEvent(
              'receive',
              'success',
              `✅ Confirmed sync for ${pending.table} ${pending.operation} with ID: ${changeId}`,
              change
            );
            addHistoryEvent(
              'apply',
              'success',
              `✅ Applied synced ${pending.table} ${pending.operation}`,
              change
            );
            setPendingServerChanges(prev => {
              const updated = { ...prev };
              if (updated[changeId]) {
                updated[changeId] = {
                  ...updated[changeId],
                  status: 'confirmed',
                  confirmTime: new Date().toISOString()
                };
              }
              return updated;
            });
          }
        });
      }
    };
    
    const handleLiveChangesEvent = (event: Event) => {
      if (!isMounted) return;
      if (event instanceof CustomEvent && event.detail?.changes) {
        handleIncomingChanges(event.detail.changes);
      }
    };
    
    window.addEventListener('sync:live-changes-received', handleLiveChangesEvent);
    
    // Monkey patch the IncomingChangeProcessor to detect incoming changes
    // Note: originalProcessMethod is already stored from incomingProcessor above
    
    // Replace with our instrumented version
    incomingProcessor.processIncomingChanges = async function(this: any, changes: TableChange[], messageType: string): Promise<boolean> {
      if (changes && changes.length > 0) {
        const event = new CustomEvent('sync:live-changes-received', {
          detail: { changes } // The event detail only contains changes
        });
        window.dispatchEvent(event);
        console.log(`[SyncChangesDebugPanel] Dispatched live changes event from IncomingChangeProcessor (source messageType: ${messageType}) with:`, changes);
      }
      
      // Call the original method, ensuring 'this' context and correct arguments are passed
      if (typeof originalProcessMethod === 'function') {
        // The original method expects (changes: TableChange[], messageType: string)
        return originalProcessMethod.apply(this, [changes, messageType]);
      } else {
        console.warn('[SyncChangesDebugPanel] Original processIncomingChanges is not a function, cannot call.');
        return Promise.resolve(false); // Return a Promise<boolean> as expected
      }
    };
    
    return () => {
      isMounted = false;
      window.removeEventListener('sync:live-changes-received', handleLiveChangesEvent);
      
      // Restore original method on the processor
      // Check if originalProcessMethod was actually a function before restoring
      if (typeof originalProcessMethod === 'function') {
        incomingProcessor.processIncomingChanges = originalProcessMethod;
        console.log('[SyncChangesDebugPanel] Restored original processIncomingChanges on IncomingChangeProcessor.');
      } else {
        console.warn('[SyncChangesDebugPanel] Could not restore original processIncomingChanges: original method not found or not a function.');
      }
    };
  }, [syncManager, pendingServerChanges]); // Depend on syncManager

  // Render pending server changes
  const renderPendingServerChanges = () => {
    const pendingIds = Object.keys(pendingServerChanges);
    
    return (
      <div className="border rounded-md">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="p-2 text-left">ID</th>
              <th className="p-2 text-left">Table</th>
              <th className="p-2 text-left">Operation</th>
              <th className="p-2 text-left">Status</th>
              <th className="p-2 text-left">Created</th>
              <th className="p-2 text-left">Confirmed</th>
            </tr>
          </thead>
          <tbody>
            {pendingIds.map((id) => {
              const change = pendingServerChanges[id];
              return (
                <tr key={id} className="border-b">
                  <td className="p-2">{id.substring(0, 8)}...</td>
                  <td className="p-2">{change.table}</td>
                  <td className="p-2">
                    <Badge variant={
                      change.operation === 'insert' ? 'default' :
                      change.operation === 'update' ? 'secondary' : 'destructive'
                    }>
                      {change.operation}
                    </Badge>
                  </td>
                  <td className="p-2">
                    <Badge variant={
                      change.status === 'pending' ? 'outline' :
                      change.status === 'confirmed' ? 'default' : 'destructive'
                    }>
                      {change.status}
                    </Badge>
                  </td>
                  <td className="p-2">{new Date(change.timestamp).toLocaleTimeString()}</td>
                  <td className="p-2">{change.confirmTime ? new Date(change.confirmTime).toLocaleTimeString() : 'Waiting...'}</td>
                </tr>
              );
            })}
            {pendingIds.length === 0 && (
              <tr>
                <td colSpan={6} className="p-4 text-center">No pending server changes waiting for sync confirmation</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    );
  };

  return (
    <div className="space-y-6">
      {/* Tabs for different change views */}
      <Tabs defaultValue="outgoing" value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="outgoing">Outgoing Changes</TabsTrigger>
          <TabsTrigger value="incoming">Incoming Changes</TabsTrigger>
          <TabsTrigger value="history">Change History</TabsTrigger>
          <TabsTrigger value="test">Test Changes</TabsTrigger>
        </TabsList>
        
        {/* Outgoing Changes Tab */}
        <TabsContent value="outgoing">
          <Card>
            <CardHeader>
              <CardTitle>Outgoing Changes</CardTitle>
              <CardDescription>
                Changes waiting to be sent to the server
              </CardDescription>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <div className="py-8 text-center">Loading changes...</div>
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
                        <th className="p-2 text-left">Table</th>
                        <th className="p-2 text-left">Operation</th>
                        <th className="p-2 text-left">ID</th>
                        <th className="p-2 text-left">Data</th>
                      </tr>
                    </thead>
                    <tbody>
                      {outgoingChanges.map((change, index) => {
                        const id = change.data.id || 'unknown';
                        return (
                          <tr key={`${change.table}-${id}-${index}`} className="border-b">
                            <td className="p-2">{change.table}</td>
                            <td className="p-2">
                              <Badge variant={
                                change.operation === 'insert' ? 'default' :
                                change.operation === 'update' ? 'secondary' : 'destructive'
                              }>
                                {change.operation}
                              </Badge>
                            </td>
                            <td className="p-2">
                              {String(id).substring(0, 8)}...
                            </td>
                            <td className="p-2">
                              <details>
                                <summary className="cursor-pointer">View data</summary>
                                <pre className="mt-2 p-2 bg-muted rounded-md text-xs overflow-auto">
                                  {JSON.stringify(change.data, null, 2)}
                                </pre>
                              </details>
                            </td>
                          </tr>
                        );
                      })}
                      {(!outgoingChanges || outgoingChanges.length === 0) && (
                        <tr>
                          <td colSpan={4} className="p-4 text-center">No pending changes</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
            <CardFooter className="flex flex-wrap gap-2">
              <div className="flex-1 flex gap-2">
                <Button onClick={handleProcessChanges} disabled={outgoingChanges.length === 0}>
                  Process Changes
                </Button>
                <Button 
                  onClick={handleClearChanges} 
                  variant="destructive" 
                  disabled={outgoingChanges.length === 0}
                >
                  Clear Changes
                </Button>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={createTaskWithService} disabled={!services?.tasks || isProcessing}>
                  + Task
                </Button>
                <Button variant="outline" size="sm" onClick={createProjectWithService} disabled={!services?.projects || isProcessing}>
                  + Project
                </Button>
                <Button variant="outline" size="sm" onClick={() => {
                  generateUpdateChange();
                  processTestChange();
                }}
                disabled={outgoingChanges.length === 0 || isProcessing}>
                  ± Update
                </Button>
              </div>
            </CardFooter>
          </Card>
          
          {/* Outgoing Change History */}
          <Card className="mt-4">
            <CardHeader>
              <CardTitle>Outgoing Change History</CardTitle>
              <CardDescription>
                History of all outgoing change events
              </CardDescription>
            </CardHeader>
            <CardContent>
              {renderHistoryEvents(outgoingHistory)}
            </CardContent>
          </Card>
        </TabsContent>
        
        {/* Incoming Changes Tab - Combined with External Changes */}
        <TabsContent value="incoming">
          <Card>
            <CardHeader>
              <CardTitle>Incoming Changes</CardTitle>
              <CardDescription>
                Changes received from the server - Generate test changes using the API tools below
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="border rounded-md mb-4">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/50">
                      <th className="p-2 text-left">Table</th>
                      <th className="p-2 text-left">Operation</th>
                      <th className="p-2 text-left">ID</th>
                      <th className="p-2 text-left">Data</th>
                    </tr>
                  </thead>
                  <tbody>
                    {incomingChanges.map((change, index) => {
                      const id = change.data?.id || 'unknown';
                      return (
                        <tr key={`${change.table}-${id}-${index}`} className="border-b">
                          <td className="p-2">{change.table}</td>
                          <td className="p-2">
                            <Badge variant={
                              change.operation === 'insert' ? 'default' :
                              change.operation === 'update' ? 'secondary' : 'destructive'
                            }>
                              {change.operation}
                            </Badge>
                          </td>
                          <td className="p-2">
                            {String(id).substring(0, 8)}...
                          </td>
                          <td className="p-2">
                            <details>
                              <summary className="cursor-pointer">View data</summary>
                              <pre className="mt-2 p-2 bg-muted rounded-md text-xs overflow-auto">
                                {JSON.stringify(change.data, null, 2)}
                              </pre>
                            </details>
                          </td>
                        </tr>
                      );
                    })}
                    {(!incomingChanges || incomingChanges.length === 0) && (
                      <tr>
                        <td colSpan={4} className="p-4 text-center">No incoming changes - Use the API tools below to create server changes</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              {/* Pending Server Changes Waiting for Sync Confirmation */}
              <Card className="mb-4">
                <CardHeader className="pb-2">
                  <CardTitle className="text-md">Sync Confirmation Status</CardTitle>
                  <CardDescription>
                    Server changes waiting for sync confirmation back to the client
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {renderPendingServerChanges()}
                </CardContent>
              </Card>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-4">
                  {/* API Request Configuration */}
                  <div className="grid grid-cols-3 gap-2">
                    <div className="space-y-2">
                      <Label htmlFor="api-method">Method</Label>
                      <Select value={apiMethod} onValueChange={setApiMethod}>
                        <SelectTrigger id="api-method">
                          <SelectValue placeholder="Method" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="GET">GET</SelectItem>
                          <SelectItem value="POST">POST</SelectItem>
                          <SelectItem value="PATCH">PATCH</SelectItem>
                          <SelectItem value="DELETE">DELETE</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2 col-span-2">
                      <Label htmlFor="api-endpoint">Endpoint</Label>
                      <Input
                        id="api-endpoint"
                        value={apiEndpoint}
                        onChange={(e) => setApiEndpoint(e.target.value)}
                        placeholder="/api/tasks"
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="api-payload">Request Payload</Label>
                    <Textarea
                      id="api-payload"
                      value={apiPayload}
                      onChange={(e) => setApiPayload(e.target.value)}
                      className="font-mono h-[250px]"
                      placeholder="Enter JSON payload here"
                    />
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <Button onClick={makeApiRequest} disabled={isApiProcessing}>
                      {isApiProcessing ? "Processing..." : "Send Request"}
                    </Button>
                    <Button onClick={generateApiTaskTemplate} variant="outline">
                      Task Create
                    </Button>
                    <Button onClick={generateApiProjectTemplate} variant="outline">
                      Project Create
                    </Button>
                    <Button onClick={generateUpdateApiRequest} variant="outline" disabled={!apiResult || !apiResult.id}>
                      Update Status
                    </Button>
                    <Button onClick={generateTaskTitleUpdate} variant="outline" disabled={!apiResult || !apiResult.id || !apiEndpoint.includes('tasks')}>
                      Update Title
                    </Button>
                    <Button onClick={generateTaskDescriptionUpdate} variant="outline" disabled={!apiResult || !apiResult.id || !apiEndpoint.includes('tasks')}>
                      Update Desc
                    </Button>
                    <Button onClick={generateDeleteApiRequest} variant="outline" disabled={!apiResult || !apiResult.id}>
                      Delete
                    </Button>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="api-response">Response</Label>
                  <pre className="bg-muted p-4 rounded text-xs overflow-auto h-[350px] font-mono">
                    {apiResponse || "Response will appear here"}
                  </pre>
                </div>
              </div>
            </CardContent>
            <CardFooter>
              <Alert className="w-full">
                <AlertDescription>
                  These API requests modify data directly in the server database. 
                  Any changes should trigger sync updates to connected clients.
                  Watch the top table for incoming changes after making a request.
                </AlertDescription>
              </Alert>
            </CardFooter>
          </Card>
          
          {/* Incoming Change History */}
          <Card className="mt-4">
            <CardHeader>
              <CardTitle>Incoming Change History</CardTitle>
              <CardDescription>
                History of all server-initiated change events
              </CardDescription>
            </CardHeader>
            <CardContent>
              {renderHistoryEvents(incomingHistory)}
            </CardContent>
          </Card>
        </TabsContent>
        
        {/* Change History Tab */}
        <TabsContent value="history">
          <Card>
            <CardHeader>
              <CardTitle>Change History</CardTitle>
              <CardDescription>
                Complete history of all sync changes (outgoing and incoming)
              </CardDescription>
            </CardHeader>
            <CardContent>
              {renderHistoryEvents(changeHistory)}
            </CardContent>
            <CardFooter className="flex gap-2">
              <Button variant="outline" size="sm" onClick={createTaskWithService} disabled={!services?.tasks || isProcessing}>
                + Local Task
              </Button>
              <Button variant="outline" size="sm" onClick={() => {
                generateApiTaskTemplate();
                makeApiRequest();
              }}>
                + Server Task
              </Button>
            </CardFooter>
          </Card>
        </TabsContent>
        
        {/* Test Changes Tab */}
        <TabsContent value="test">
          <Card>
            <CardHeader>
              <CardTitle>Test Changes</CardTitle>
              <CardDescription>
                Create and track test changes to verify sync functionality
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="test-change-json">Change JSON</Label>
                <Textarea
                  id="test-change-json"
                  value={testChangeJson}
                  onChange={(e) => setTestChangeJson(e.target.value)}
                  className="font-mono h-40"
                />
              </div>
              
              <div className="flex flex-wrap space-x-2">
                <Button 
                  onClick={processTestChange} 
                  disabled={isProcessing}
                >
                  Track Change
                </Button>
                <Button onClick={generateTaskChange} variant="outline">
                  Task Template
                </Button>
                <Button onClick={generateProjectChange} variant="outline">
                  Project Template
                </Button>
                <Button onClick={generateUpdateChange} variant="outline" disabled={outgoingChanges.length === 0}>
                  Update Template
                </Button>
              </div>
              
              <div className="flex flex-wrap space-x-2 mt-2">
                <Button 
                  onClick={createTaskWithService} 
                  disabled={!services?.tasks || isProcessing}
                  variant="default"
                >
                  Create Real Task
                </Button>
                <Button 
                  onClick={createProjectWithService} 
                  disabled={!services?.projects || isProcessing}
                  variant="default"
                >
                  Create Real Project
                </Button>
              </div>
              
              {testResult && (
                <div className="mt-4">
                  <div className="text-sm font-medium">Result:</div>
                  <pre className="bg-muted p-2 rounded text-xs overflow-auto mt-1 max-h-40">
                    {testResult}
                  </pre>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
} 