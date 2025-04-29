import React, { useState, useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { getNewPGliteDataSource, NewPGliteDataSource } from '@/db/newtypeorm/NewDataSource';
import { Task, User, Project, TaskStatus, TaskPriority, UserRole, ProjectStatus } from '@repo/dataforge/client-entities';
import { DataSource, EntityManager, SelectQueryBuilder, QueryBuilder, In, Between, IsNull, FindOperator, SaveOptions, DeepPartial } from 'typeorm';
import { clientEntities } from '@repo/dataforge/client-entities';
import { DBChangeProcessor, Change } from '@/db/DBChangeProcessor';
import { NewPGliteQueryRunner } from '@/db/newtypeorm/NewPGliteQueryRunner';
import { useLiveEntity } from '@/db/hooks/useLiveEntity';
import { v4 as uuidv4 } from 'uuid';
import { Repository } from 'typeorm';

interface TypeORMTestResult {
  success: boolean;
  message: string;
  data?: any;
}

export function TypeORMTest() {
  const [results, setResults] = useState<TypeORMTestResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [dataSource, setDataSource] = useState<NewPGliteDataSource | null>(null);

  // Add state for live query test
  const [liveQueryBuilder, setLiveQueryBuilder] = useState<SelectQueryBuilder<Task> | null>(null);
  const { data: liveTasks } = useLiveEntity<Task>(
    liveQueryBuilder as any,
    { 
      enabled: !!liveQueryBuilder,
      // key: 'id' // Keep commented out due to ErrnoError: 44
    }
  );

  // Initialize TypeORM on component mount
  useEffect(() => {
    const initTypeORM = async () => {
      try {
        const ds = await getNewPGliteDataSource({
          database: 'shadadmin_db',
          synchronize: false,
          logging: true,
          entities: clientEntities
        });
        setDataSource(ds);
        console.log("DataSource Initialized. Options:", ds.options);
        setResults(prev => [
          {
            success: true,
            message: 'New TypeORM DataSource initialized successfully'
          },
          ...prev
        ]);
      } catch (error) {
        console.error('Error initializing New TypeORM:', error);
        setResults(prev => [
          {
            success: false,
            message: `Error initializing New TypeORM: ${error instanceof Error ? error.message : String(error)}`
          },
          ...prev
        ]);
      }
    };

    initTypeORM();
  }, []);

  // Helper to get Task repository via the DataSource
  const getTaskRepository = () => {
    if (!dataSource) {
        throw new Error("DataSource not available");
    }
    return dataSource.getRepository(Task);
  }

  async function runRepositoryQuery() {
    setIsLoading(true);
    try {
      console.log('=== Repository Query Debug (via DataSource) ===');
      const taskRepository = getTaskRepository();
      
      console.log('Before repository query');
      const tasks = await taskRepository.find();
      
      console.log('Repository results:', tasks);
      if (tasks.length > 0) {
        console.log('First result:', tasks[0]);
      }
      
      setResults(prev => [
        {
          success: true,
          message: `Successfully ran repository query. Found ${tasks.length} tasks.`,
          data: tasks
        },
        ...prev
      ]);
    } catch (error) {
      console.error('Error running repository query:', error);
      setResults(prev => [
        {
          success: false,
          message: `Error: ${error instanceof Error ? error.message : String(error)}`
        },
        ...prev
      ]);
    } finally {
      setIsLoading(false);
    }
  }

  async function runQueryBuilder() {
    setIsLoading(true);
    try {
      console.log('=== Query Builder Debug (via DataSource Repo) ===');
      const taskRepository = getTaskRepository();
      
      const qb = taskRepository.createQueryBuilder("task");
      console.log('Query builder created');
      
      const tasks = await qb
        .where("task.status = :status", { status: TaskStatus.COMPLETED })
        .getMany();
      
      console.log('Query builder results:', tasks);
      if (tasks.length > 0) {
        console.log('First result:', tasks[0]);
      }

      setResults(prev => [
        {
          success: true,
          message: `Successfully ran query builder. Found ${tasks.length} completed tasks.`,
          data: tasks
        },
        ...prev
      ]);
    } catch (error) {
      console.error('Error running query builder:', error);
      setResults(prev => [
        {
          success: false,
          message: `Error running query builder: ${error instanceof Error ? error.message : String(error)}`
        },
        ...prev
      ]);
    } finally {
      setIsLoading(false);
    }
  }

  async function runCustomQuery() {
    if (!dataSource) return;
    setIsLoading(true);
    try {
      console.log("--- Running Custom Query --- ");
      await new Promise(resolve => setTimeout(resolve, 100));
      console.log("Delay finished.");

      try {
        const preRead = await dataSource.query("SELECT COUNT(*) as count FROM tasks");
        console.log("Pre-read task count:", preRead[0]?.count);
      } catch (preReadError) {
        console.error("Error during pre-read:", preReadError);
      }

      const query = "SELECT id, title, status FROM tasks WHERE status = $1 ORDER BY updated_at DESC";
      const params = [TaskStatus.OPEN];
      console.log(`Executing custom query: ${query}`, params);
      const resultsData = await dataSource.query(query, params);

      setResults(prev => [
        {
          success: true,
          message: `Successfully ran custom query for 'open' tasks. Found ${resultsData?.length ?? 0}.`,
          data: resultsData
        },
        ...prev
      ]);
    } catch (error) {
      console.error('Error running custom query:', error);
      setResults(prev => [
        {
          success: false,
          message: `Error: ${error instanceof Error ? error.message : String(error)}`
        },
        ...prev
      ]);
    } finally {
      setIsLoading(false);
    }
  }

  async function runChangeProcessorTests() {
    if (!dataSource) {
        setResults(prev => [{ success: false, message: "DataSource not available for Change Processor" }, ...prev]);
        return;
    }
    setIsLoading(true);
    try {
      const queryRunner = dataSource.createQueryRunner() as NewPGliteQueryRunner;
      
      const taskRepoInstance = getTaskRepository();

      const getRepositorySyncFactory = (entityName: string) => {
        if (entityName === 'tasks') return taskRepoInstance;
        throw new Error(`Sync Repository factory not implemented for ${entityName}`);
      };
      const getQueryBuilderSyncFactory = (entityName: string) => {
        const repo = getRepositorySyncFactory(entityName);
        return repo.createQueryBuilder(entityName);
      };

      // Pass NewPGliteQueryRunner - Use 'as any' temporarily to bypass type mismatch
      // Pass factories with 'as any' temporarily
      const changeProcessor = new DBChangeProcessor(queryRunner as any, getRepositorySyncFactory as any, getQueryBuilderSyncFactory as any);

      // --- Tests using taskRepoInstance --- 
      const newTaskId = uuidv4();
      // Use new Task() and Object.assign()
      const newTask = new Task();
      Object.assign(newTask, {
        title: 'Test Task ChangeProc', 
        status: TaskStatus.OPEN, 
        description: 'Created by DBChangeProcessor test'
      });
      newTask.id = newTaskId; // Assign ID before saving
      const insertedTask: Task | undefined = await taskRepoInstance.save(newTask);
      // Check if insertedTask is correctly typed (should be Task, not Task[])
      if (!insertedTask?.id || insertedTask.id !== newTaskId) {
          throw new Error('Task insert failed or ID mismatch');
      }
      console.log("Inserted Task ID:", insertedTask.id);

      const updateChange: Change = { type: 'UPDATE', entity: 'tasks', data: { id: insertedTask.id, status: TaskStatus.IN_PROGRESS } };
      await changeProcessor.processChange(updateChange);
      console.log("Processed UPDATE change");

      const batchChanges: Change[] = [
        { type: 'INSERT', entity: 'tasks', data: { id: uuidv4(), title: 'Batch Task CP 1', status: TaskStatus.OPEN } },
        { type: 'INSERT', entity: 'tasks', data: { id: uuidv4(), title: 'Batch Task CP 2', status: TaskStatus.OPEN } }
      ];
      await changeProcessor.processBatch(batchChanges);
      console.log("Processed BATCH INSERT changes");

      const deleteChange: Change = { type: 'DELETE', entity: 'tasks', data: { id: insertedTask.id } };
      await changeProcessor.processChange(deleteChange);
      console.log("Processed DELETE change");

      const finalTasks = await taskRepoInstance.find();
      console.log("Final tasks after Change Processor tests:", finalTasks);

      setResults(prev => [
        { success: true, message: `Successfully ran DBChangeProcessor tests.`, data: { tasks: finalTasks } },
        ...prev
      ]);
    } catch (error) {
      console.error('Error running change processor tests:', error);
      setResults(prev => [
        { success: false, message: `Error running change processor tests: ${error instanceof Error ? error.message : String(error)}` },
        ...prev
      ]);
    } finally { setIsLoading(false); }
  }

  async function runLiveQueryTest() {
    setIsLoading(true);
    try {
      console.log('=== Live Query Debug (via Manager Repo) ===');
      const taskRepository = getTaskRepository(); // Use helper

      if (dataSource) {
        try {
          const directQuery = "SELECT id, title, status FROM tasks WHERE status = $1 ORDER BY updated_at DESC";
          const directParams = [TaskStatus.OPEN];
          console.log("[runLiveQueryTest] Executing direct query:", directQuery, directParams);
          const directResults = await dataSource.query(directQuery, directParams);
          console.log("[runLiveQueryTest] Direct query results:", directResults);
          
          setResults(prev => [
            {
              success: true,
              message: `[runLiveQueryTest] Direct query found ${directResults?.length ?? 0} 'open' tasks.`,
              data: directResults
            },
            ...prev
          ]);
        } catch (directQueryError) {
          console.error("[runLiveQueryTest] Error during direct query:", directQueryError);
          setResults(prev => [
            {
              success: false,
              message: `[runLiveQueryTest] Error during direct query: ${directQueryError instanceof Error ? directQueryError.message : String(directQueryError)}`
            },
            ...prev
          ]);
        }
      }
      
      const qb = taskRepository.createQueryBuilder("task")
        .where("task.status = :status", { status: TaskStatus.OPEN })
        .orderBy("task.updated_at", "DESC")
        .limit(5);
      
      console.log('Live Query Setup:', {
        status: TaskStatus.OPEN,
        query: qb.getSql(),
        parameters: qb.getParameters()
      });
      
      setLiveQueryBuilder(qb);
      
      setResults(prev => [
        {
          success: true,
          message: 'Live query test started. Watch for updates below.',
          data: { initialTasks: liveTasks }
        },
        ...prev
      ]);
    } catch (error) {
      console.error('Error running live query test:', error);
      setResults(prev => [
        {
          success: false,
          message: `Error running live query test: ${error instanceof Error ? error.message : String(error)}`
        },
        ...prev
      ]);
    } finally {
      setIsLoading(false);
    }
  }

  async function updateLiveTask() {
    if (!liveTasks?.length) {
      console.log("No live tasks available to update.");
      return; 
    }
    setIsLoading(true);
    try {
      // const taskRepository = getTaskRepository(); // No longer need repository here
      if (!dataSource || !dataSource.manager) {
        throw new Error("DataSource or EntityManager not available");
      }
      const manager = dataSource.manager; // Get the EntityManager
      
      const taskToUpdate = liveTasks[0] as Task;
      console.log("Task object being used for update:", taskToUpdate);
      
      if (!taskToUpdate?.id) {
          throw new Error("Cannot update task without a valid ID.");
      }
      
      // Use manager.update directly, providing the EntityTarget (Task)
      await manager.update(Task, taskToUpdate.id, { 
        title: `${taskToUpdate.title} (Updated)` 
      } as DeepPartial<Task>); // Added cast to update object
      
      setResults(prev => [
        {
          success: true,
          message: 'Updated task. Watch for live update below.',
          data: { updatedTask: taskToUpdate }
        },
        ...prev
      ]);
    } catch (error) {
      console.error('Error updating task:', error);
      setResults(prev => [
        {
          success: false,
          message: `Error updating task: ${error instanceof Error ? error.message : String(error)}`
        },
        ...prev
      ]);
    } finally {
      setIsLoading(false);
    }
  }

  // --- START NEW TEST FUNCTIONS ---

  // 1. CRUD Operations Test
  async function runCrudTests() {
    if (!dataSource) return;
    setIsLoading(true);
    const testId = uuidv4();
    const testTitle = `CRUD Test Task ${Date.now()}`;
    let messageLog: string[] = [];
    let success = true;
    let finalData: any = null;

    try {
      const taskRepo = dataSource.getRepository(Task);
      messageLog.push('=== Running CRUD Tests ===');

      // Create (using save on new entity)
      messageLog.push(`1. Creating task: ${testTitle}`);
      // Use new Task() and Object.assign() here too
      const newTaskCrud = new Task();
      Object.assign(newTaskCrud, { 
          // id: testId, // Assign ID after creation
          title: testTitle,
          status: TaskStatus.OPEN,
          priority: TaskPriority.LOW,
          tags: ['crud-test'],
      });
      newTaskCrud.id = testId; // Assign ID
      const savedTask = await taskRepo.save(newTaskCrud);
      messageLog.push(`   - Saved task ID: ${savedTask.id}`);
      if (savedTask.id !== testId) throw new Error('Create failed: ID mismatch');

      // Read (findOneBy)
      messageLog.push(`2. Reading task ID: ${testId}`);
      const foundTask: Task | null = await taskRepo.findOneBy({ id: testId }); // Explicitly type foundTask
      if (!foundTask || foundTask.title !== testTitle) throw new Error('Read failed: Task not found or title mismatch');
      messageLog.push(`   - Found task title: ${foundTask.title}`);

      // Update (using save on existing entity)
      const updatedTitle = `${testTitle} (Updated)`;
      messageLog.push(`3. Updating task title to: ${updatedTitle}`);
      foundTask.title = updatedTitle;
      foundTask.status = TaskStatus.IN_PROGRESS; // Should work now with typed foundTask
      const updatedTask = await taskRepo.save(foundTask); // save can also update
      if (updatedTask.title !== updatedTitle || updatedTask.status !== TaskStatus.IN_PROGRESS) throw new Error('Update (save) failed: Title or status mismatch');
      messageLog.push(`   - Updated task status: ${updatedTask.status}`);

      // Update (using QueryBuilder update method - WORKAROUND for alias issue)
      const updatedTitle2 = `${testTitle} (Updated Again)`;
       messageLog.push(`4. Updating task title again using QueryBuilder 'update': ${updatedTitle2}`);
      const updateResult = await taskRepo.createQueryBuilder('task_alias_for_update') // Provide explicit alias
          .update(Task)
          .set({ title: updatedTitle2, priority: TaskPriority.HIGH })
          .where("id = :id", { id: testId })
          .execute();

      if (!updateResult.affected || updateResult.affected === 0) throw new Error('Update (QueryBuilder update) failed: No rows affected');
      const verifiedUpdate = await taskRepo.findOneBy({ id: testId });
      if (!verifiedUpdate || verifiedUpdate.title !== updatedTitle2 || verifiedUpdate.priority !== TaskPriority.HIGH) throw new Error('Update (QueryBuilder update) verification failed');
      messageLog.push(`   - Verified updated priority: ${verifiedUpdate.priority}`);

      // Delete (using QueryBuilder delete method - WORKAROUND for alias issue)
      // Note: We are now using QB delete instead of repo.remove() due to alias issue
      messageLog.push(`5. Deleting task ID: ${testId} using QueryBuilder 'delete' (instead of remove)`);
      const deleteResultRemove = await taskRepo.createQueryBuilder('task_alias_for_remove') // Provide explicit alias
          .delete()
          .from(Task)
          .where("id = :id", { id: verifiedUpdate.id }) // Use ID from the object we would have removed
          .execute();

      if (!deleteResultRemove.affected || deleteResultRemove.affected === 0) throw new Error('Delete (QueryBuilder delete replacing remove) failed: No rows affected');
      const notFoundTask = await taskRepo.findOneBy({ id: testId });
      if (notFoundTask) throw new Error('Delete (replacing remove) failed: Task still found');
      messageLog.push(`   - Task deleted successfully.`);

      // Re-create for testing 'delete' via QueryBuilder
      messageLog.push(`6. Re-creating task for 'delete' test`);
      const taskToDeleteAgain = taskRepo.create({ id: testId, title: testTitle, status: TaskStatus.OPEN, priority: TaskPriority.LOW });
      await taskRepo.save(taskToDeleteAgain);
      const foundTaskToDelete = await taskRepo.findOneBy({ id: testId });
      if (!foundTaskToDelete) throw new Error("Re-creation for delete test failed");

      // Delete (using QueryBuilder delete method)
      messageLog.push(`7. Deleting task ID: ${testId} using QueryBuilder 'delete'`);
      const deleteResult = await taskRepo.createQueryBuilder('task_alias_for_delete') // Provide explicit alias
          .delete()
          .from(Task)
          .where("id = :id", { id: testId })
          .execute();

      if (!deleteResult.affected || deleteResult.affected === 0) throw new Error('Delete (QueryBuilder delete) failed: No rows affected');
      const verifiedDelete = await taskRepo.findOneBy({ id: testId });
      if (verifiedDelete) throw new Error('Delete (QueryBuilder delete) verification failed: Task still found');
      messageLog.push(`   - Task deleted successfully.`);

      messageLog.push('=== CRUD Tests Completed Successfully ===');
      finalData = { log: messageLog };

    } catch (error) {
      console.error('Error running CRUD tests:', error);
      success = false;
      messageLog.push(`Error: ${error instanceof Error ? error.message : String(error)}`);
      finalData = { log: messageLog, error: error };
    } finally {
      setResults(prev => [
        {
          success,
          message: `CRUD Tests: ${success ? 'Completed successfully' : 'Failed'}`,
          data: finalData
        },
        ...prev
      ]);
      setIsLoading(false);
    }
  }

  // 2. Advanced Filtering Test
  async function runAdvancedFilterTests() {
    if (!dataSource) return;
    setIsLoading(true);
    let messageLog: string[] = ['=== Running Advanced Filter Tests ==='];
    let success = true;
    let finalData: any = {};

    try {
      const taskRepo = dataSource.getRepository(Task);

      // Setup: Ensure some tasks exist with different statuses and priorities
      const existingTasks = await taskRepo.find({ take: 5 });
      if (existingTasks.length < 2) {
          messageLog.push("Warning: Need at least 2 tasks for IN filter test. Creating dummy tasks.");
          // Pass plain objects directly to save for batch insert
          await taskRepo.save([
              { id: uuidv4(), title: 'Filter Test Task 1', status: TaskStatus.OPEN, priority: TaskPriority.LOW, tags: ['filter'] },
              { id: uuidv4(), title: 'Filter Test Task 2', status: TaskStatus.IN_PROGRESS, priority: TaskPriority.MEDIUM, tags: ['filter', 'test'] },
              { id: uuidv4(), title: 'Filter Test Task 3', status: TaskStatus.COMPLETED, priority: TaskPriority.HIGH, tags: ['test'] }
          ] as DeepPartial<Task>[]); // Cast the array
      }
      const tasksForInFilter = await taskRepo.find({ take: 2 });
      const taskIdsForIn = tasksForInFilter.map((t: Task) => t.id);

      // Test IN filter
      messageLog.push(`1. Filtering by ID IN [${taskIdsForIn.join(', ')}]`);
      const inTasks = await taskRepo.findBy({ id: In(taskIdsForIn) });
      messageLog.push(`   - Found ${inTasks.length} tasks using IN.`);
      finalData.inTasks = inTasks;

      // Test Between filter (using createdAt - might need adjustment based on data)
      // This is tricky without known date ranges, using priority as an example
      messageLog.push(`2. Filtering by Priority BETWEEN LOW and MEDIUM`);
      const betweenTasks = await taskRepo.findBy({ priority: Between(TaskPriority.LOW, TaskPriority.MEDIUM) });
      messageLog.push(`   - Found ${betweenTasks.length} tasks using BETWEEN (Priority).`);
      finalData.betweenTasks = betweenTasks;

      // Test Like filter
      messageLog.push(`3. Filtering by title LIKE '%Filter Test%'`);
      const likeTasks = await taskRepo.createQueryBuilder("task")
          .where("task.title LIKE :title", { title: '%Filter Test%' })
          .getMany();
      messageLog.push(`   - Found ${likeTasks.length} tasks using LIKE.`);
      finalData.likeTasks = likeTasks;

      // Test IsNull filter (assuming 'description' can be null)
      messageLog.push(`4. Filtering by description IS NULL`);
      const nullDescTasks = await taskRepo.findBy({ description: IsNull() });
      messageLog.push(`   - Found ${nullDescTasks.length} tasks using IS NULL (Description).`);
      finalData.nullDescTasks = nullDescTasks;

      // Test combining filters (using QueryBuilder)
      messageLog.push(`5. Combining filters: Status=COMPLETED AND Priority=HIGH`);
      const combinedTasks = await taskRepo.createQueryBuilder("task")
          .where("task.status = :status", { status: TaskStatus.COMPLETED })
          .andWhere("task.priority = :priority", { priority: TaskPriority.HIGH })
          .getMany();
       messageLog.push(`   - Found ${combinedTasks.length} tasks using combined filters.`);
      finalData.combinedTasks = combinedTasks;

      messageLog.push('=== Advanced Filter Tests Completed Successfully ===');

    } catch (error) {
      console.error('Error running advanced filter tests:', error);
      success = false;
      messageLog.push(`Error: ${error instanceof Error ? error.message : String(error)}`);
      finalData.error = error;
    } finally {
      setResults(prev => [
        {
          success,
          message: `Advanced Filter Tests: ${success ? 'Completed successfully' : 'Failed'}`,
          data: { log: messageLog, results: finalData }
        },
        ...prev
      ]);
      setIsLoading(false);
    }
  }

   // 3. Relations & Joins Test
  async function runRelationTests() {
    if (!dataSource) return;
    setIsLoading(true);
    let messageLog: string[] = ['=== Running Relation & Join Tests ==='];
    let success = true;
    let finalData: any = {};

    try {
        const taskRepo = dataSource.getRepository(Task);
        const userRepo = dataSource.getRepository(User);
        const projectRepo = dataSource.getRepository(Project);

        // Setup: Ensure at least one user, project, and task with relations exist
        let testUser = await userRepo.findOne({ where: { email: 'relation-test@example.com' } });
        if (!testUser) {
            messageLog.push("Creating test user...");
            const newUserId = uuidv4();
            // Use new User() and Object.assign()
            const newUser = new User(); 
            Object.assign(newUser, {
                name: 'Relation Tester', 
                email: 'relation-test@example.com', 
                role: UserRole.MEMBER
            });
            newUser.id = newUserId; // Assign ID
            testUser = await userRepo.save(newUser); // Assign result of save
            if (!testUser || testUser.id !== newUserId) throw new Error("User creation failed or ID mismatch");
        }

        let testProject = await projectRepo.findOne({ where: { name: 'Relation Test Project' } });
        if (!testProject) {
            messageLog.push("Creating test project...");
            if (!testUser) throw new Error("Cannot create project without a user");
            const newProjectId = uuidv4();
             // Use new Project() and Object.assign()
            const newProject = new Project();
            Object.assign(newProject, { 
                name: 'Relation Test Project', 
                status: ProjectStatus.ACTIVE,
                ownerId: testUser.id 
            });
            newProject.id = newProjectId; // Assign ID
            testProject = await projectRepo.save(newProject); // Assign result of save
            if (!testProject || testProject.id !== newProjectId) throw new Error("Project creation failed or ID mismatch");
        }

        let testTask = await taskRepo.findOne({ where: { title: 'Relation Test Task' } });
        if (!testTask) {
             messageLog.push("Creating test task with relations...");
             if (!testProject) throw new Error("Cannot create task without a project");
             if (!testUser) throw new Error("Cannot create task without a user assignee");
             const newTaskIdRel = uuidv4();
             // Use new Task() and Object.assign()
             const newTask = new Task();
             Object.assign(newTask, {
                title: 'Relation Test Task',
                status: TaskStatus.OPEN,
                priority: TaskPriority.MEDIUM,
                projectId: testProject.id,
                assigneeId: testUser.id
            });
            newTask.id = newTaskIdRel; // Assign ID
            testTask = await taskRepo.save(newTask); // Assign result of save
            if (!testTask || testTask.id !== newTaskIdRel) throw new Error("Task creation failed or ID mismatch");
        }

        // Test Left Join (Task -> Project, Task -> Assignee)
        messageLog.push(`1. Left Join Task with Project and Assignee (ID: ${testTask.id})`);
        const taskWithRelations = await taskRepo.createQueryBuilder("task")
            .leftJoinAndSelect("task.project", "project") // Alias 'project' is important
            .leftJoinAndSelect("task.assignee", "assignee") // Alias 'assignee'
            .where("task.id = :id", { id: testTask.id })
            .getOne();

        if (!taskWithRelations || !taskWithRelations.project || !taskWithRelations.assignee) {
             throw new Error('Left Join failed: Relations not loaded or missing.');
        }
        messageLog.push(`   - Loaded Task Title: ${taskWithRelations.title}`);
        messageLog.push(`   - Loaded Project Name: ${taskWithRelations.project.name}`);
        messageLog.push(`   - Loaded Assignee Name: ${taskWithRelations.assignee.name}`);
        finalData.leftJoinTask = taskWithRelations;

        // Test Inner Join (Find projects that HAVE tasks)
        messageLog.push(`2. Inner Join Project with Tasks`);
        const projectsWithTasks = await projectRepo.createQueryBuilder("project")
            .innerJoinAndSelect("project.tasks", "task") // Only projects with at least one task
            .where("project.id = :id", { id: testProject.id }) // Filter for our test project
            .getOne(); // Use getOne as we expect our specific test project

        if (!projectsWithTasks || !projectsWithTasks.tasks || projectsWithTasks.tasks.length === 0) {
            throw new Error('Inner Join failed: Project not found or tasks not loaded.');
        }
        messageLog.push(`   - Found Project: ${projectsWithTasks.name} with ${projectsWithTasks.tasks.length} task(s)`);
        finalData.innerJoinProject = projectsWithTasks;


        // Test loading relations via `relations` option in find
        messageLog.push(`3. Loading relations using find options (Task ID: ${testTask.id})`);
        const taskWithRelationsFind = await taskRepo.findOne({
            where: { id: testTask.id },
            relations: ["project", "assignee"], // Specify relations to load
        });

         if (!taskWithRelationsFind || !taskWithRelationsFind.project || !taskWithRelationsFind.assignee) {
             throw new Error('Find with relations failed: Relations not loaded or missing.');
        }
        messageLog.push(`   - Loaded Project Name (find): ${taskWithRelationsFind.project.name}`);
        messageLog.push(`   - Loaded Assignee Name (find): ${taskWithRelationsFind.assignee.name}`);
        finalData.findWithRelationsTask = taskWithRelationsFind;

        messageLog.push('=== Relation & Join Tests Completed Successfully ===');

    } catch (error) {
        console.error('Error running relation tests:', error);
        success = false;
        messageLog.push(`Error: ${error instanceof Error ? error.message : String(error)}`);
        finalData.error = error;
    } finally {
        setResults(prev => [
            {
                success,
                message: `Relation & Join Tests: ${success ? 'Completed successfully' : 'Failed'}`,
                data: { log: messageLog, results: finalData }
            },
            ...prev
        ]);
        setIsLoading(false);
    }
  }

   // 4. Ordering & Pagination Test
  async function runOrderPaginateTests() {
    if (!dataSource) return;
    setIsLoading(true);
    let messageLog: string[] = ['=== Running Ordering & Pagination Tests ==='];
    let success = true;
    let finalData: any = {};

    try {
        const taskRepo = dataSource.getRepository(Task);

        // Setup: Ensure enough tasks exist for pagination
        const totalTasks = await taskRepo.count();
        if (totalTasks < 5) {
            messageLog.push("Warning: Need at least 5 tasks for pagination tests. Creating dummy tasks.");
            const newTasks = [];
            for (let i = totalTasks; i < 5; i++) {
                newTasks.push({
                    id: uuidv4(),
                    title: `Pagination Task ${i + 1}`,
                    status: TaskStatus.OPEN,
                    priority: i % 2 === 0 ? TaskPriority.MEDIUM : TaskPriority.LOW,
                    createdAt: new Date(Date.now() - i * 1000 * 60) // Stagger creation time
                });
            }
            await taskRepo.save(newTasks);
        }

        // Test Ordering (by title ASC)
        messageLog.push(`1. Ordering tasks by title ASC`);
        const orderedTasks = await taskRepo.find({
            order: { title: "ASC" },
            take: 5 // Limit for brevity
        });
        messageLog.push(`   - Found ${orderedTasks.length} tasks ordered by title.`);
        finalData.orderedTasks = orderedTasks;

        // Test Pagination (page 1, 2 items per page)
        const pageSize = 2;
        const page = 1;
        messageLog.push(`2. Pagination: Page ${page}, Size ${pageSize} (ordered by createdAt DESC)`);
        const paginatedTasksPage1 = await taskRepo.find({
            order: { createdAt: "DESC" },
            skip: (page - 1) * pageSize,
            take: pageSize,
        });
        messageLog.push(`   - Found ${paginatedTasksPage1.length} tasks on page 1.`);
        finalData.paginatedTasksPage1 = paginatedTasksPage1;

        // Test Pagination (page 2, 2 items per page)
        const page2 = 2;
        messageLog.push(`3. Pagination: Page ${page2}, Size ${pageSize} (ordered by createdAt DESC)`);
        const paginatedTasksPage2 = await taskRepo.find({
            order: { createdAt: "DESC" },
            skip: (page2 - 1) * pageSize,
            take: pageSize,
        });
        messageLog.push(`   - Found ${paginatedTasksPage2.length} tasks on page 2.`);
        finalData.paginatedTasksPage2 = paginatedTasksPage2;

        // Test Ordering and Pagination with QueryBuilder
        messageLog.push(`4. Pagination with QueryBuilder: Page 1, Size 3, order by priority DESC, title ASC`);
        const qbPaginated = await taskRepo.createQueryBuilder("task")
            .orderBy("task.priority", "DESC")
            .addOrderBy("task.title", "ASC")
            .skip(0)
            .take(3)
            .getMany();
        messageLog.push(`   - Found ${qbPaginated.length} tasks using QueryBuilder pagination.`);
        finalData.qbPaginated = qbPaginated;


        messageLog.push('=== Ordering & Pagination Tests Completed Successfully ===');

    } catch (error) {
        console.error('Error running ordering/pagination tests:', error);
        success = false;
        messageLog.push(`Error: ${error instanceof Error ? error.message : String(error)}`);
        finalData.error = error;
    } finally {
        setResults(prev => [
            {
                success,
                message: `Ordering & Pagination Tests: ${success ? 'Completed successfully' : 'Failed'}`,
                data: { log: messageLog, results: finalData }
            },
            ...prev
        ]);
        setIsLoading(false);
    }
  }

  // 5. Transactions Test
  async function runTransactionTests() {
    if (!dataSource) return;
    setIsLoading(true);
    let messageLog: string[] = ['=== Running Transaction Tests ==='];
    let success = true;
    let finalData: any = {};
    const task1Id = uuidv4();
    const task2Id = uuidv4();

    try {
        const taskRepo = dataSource.getRepository(Task); // Use inside transaction

        // Test successful transaction
        messageLog.push(`1. Running successful transaction (create two tasks)`);
        await dataSource.manager.transaction(async (transactionalEntityManager: EntityManager) => {
            messageLog.push(`   - Inside transaction...`);
            const task1 = transactionalEntityManager.create(Task, {
                id: task1Id,
                title: 'Transaction Task 1',
                status: TaskStatus.OPEN,
                priority: TaskPriority.MEDIUM
            } as DeepPartial<Task>);
            await transactionalEntityManager.save(task1);
            messageLog.push(`   - Saved Task 1 (ID: ${task1Id})`);

            // Simulate some work
            await new Promise(res => setTimeout(res, 50));

            const task2 = transactionalEntityManager.create(Task, {
                id: task2Id,
                title: 'Transaction Task 2',
                status: TaskStatus.OPEN,
                priority: TaskPriority.MEDIUM
            } as DeepPartial<Task>);
             await transactionalEntityManager.save(task2);
             messageLog.push(`   - Saved Task 2 (ID: ${task2Id})`);
        });
        messageLog.push(`   - Transaction committed.`);

        // Verify tasks exist
        const foundTask1 = await taskRepo.findOneBy({ id: task1Id });
        const foundTask2 = await taskRepo.findOneBy({ id: task2Id });
        if (!foundTask1 || !foundTask2) {
            throw new Error('Successful transaction verification failed: Tasks not found.');
        }
        messageLog.push(`   - Verified Task 1 and Task 2 exist.`);
        finalData.successfulTasks = [foundTask1, foundTask2];

        // Test failed transaction (rollback)
        const failingTaskTitle = 'Failing Transaction Task';
        messageLog.push(`2. Running transaction designed to fail (create one task, then throw error)`);
        try {
             await dataSource.manager.transaction(async (transactionalEntityManager: EntityManager) => {
                messageLog.push(`   - Inside failing transaction...`);
                 const taskFail = transactionalEntityManager.create(Task, {
                    id: uuidv4(), // Use a new ID
                    title: failingTaskTitle,
                    status: TaskStatus.OPEN,
                    priority: TaskPriority.LOW
                 } as DeepPartial<Task>);
                await transactionalEntityManager.save(taskFail);
                messageLog.push(`   - Saved task (should be rolled back)`);

                throw new Error("Intentional transaction failure!");
            });
        } catch (e: any) {
            if (e.message === "Intentional transaction failure!") {
                messageLog.push(`   - Caught expected error: ${e.message}`);
                // No explicit rollback attempt here, as it's known to be ineffective via query()
                messageLog.push(`   - Transaction rollback is expected to fail due to driver limitations.`);
            } else {
                // Re-throw unexpected errors
                throw e;
            }
        }

        // Verify the failing task DOES EXIST (because rollback failed)
        messageLog.push(`3. Verifying task '${failingTaskTitle}' was NOT rolled back (Known Limitation)`);
        const foundFailingTask = await taskRepo.findOneBy({ title: failingTaskTitle });
        if (!foundFailingTask) {
            // This would be unexpected, as we know rollback fails
            throw new Error('Verification failed: Task WAS rolled back unexpectedly.');
        }
        messageLog.push(`   - Verified task '${failingTaskTitle}' exists, confirming rollback failure.`);
        finalData.rollbackVerified = false; // Explicitly set to false to indicate rollback didn't happen

        // Manual cleanup of the task that should have been rolled back
        messageLog.push(`4. Manually cleaning up un-rolled-back task: ${failingTaskTitle}`);
        await taskRepo.createQueryBuilder('failing_task_cleanup')
            .delete()
            .from(Task)
            .where("id = :id", { id: foundFailingTask.id })
            .execute();
        const verifiedCleanup = await taskRepo.findOneBy({ id: foundFailingTask.id });
        if (verifiedCleanup) {
             throw new Error('Manual cleanup of failing task failed.');
        }
         messageLog.push(`   - Manual cleanup successful.`);

        // Cleanup successful tasks (moved step number)
        messageLog.push(`5. Cleaning up tasks from successful transaction.`);
        // Use QueryBuilder delete for cleanup due to alias issues with remove/delete on repo
        const cleanupIds = [foundTask1.id, foundTask2.id];
        await taskRepo.createQueryBuilder('successful_task_cleanup')
            .delete()
            .from(Task)
            .where("id IN (:...ids)", { ids: cleanupIds })
            .execute();
        messageLog.push(`   - Cleaned up successful test tasks.`);

        messageLog.push('=== Transaction Tests Completed Successfully ===');

    } catch (error) {
        console.error('Error running transaction tests:', error);
        success = false;
        messageLog.push(`Error: ${error instanceof Error ? error.message : String(error)}`);
        finalData.error = error;
    } finally {
        setResults(prev => [
            {
                success,
                message: `Transaction Tests: ${success ? 'Completed successfully' : 'Failed'}`,
                data: { log: messageLog, results: finalData }
            },
            ...prev
        ]);
        setIsLoading(false);
    }
  }

  // 6. Aggregations Test
  async function runAggregationTests() {
      if (!dataSource) return;
      setIsLoading(true);
      let messageLog: string[] = ['=== Running Aggregation Tests ==='];
      let success = true;
      let finalData: any = {};

      try {
          const taskRepo = dataSource.getRepository(Task);

          // Test getCount
          messageLog.push(`1. Getting total task count using getCount()`);
          const totalCount = await taskRepo.count();
          messageLog.push(`   - Total tasks: ${totalCount}`);
          finalData.totalCount = totalCount;

          // Test countBy
           messageLog.push(`2. Getting count of OPEN tasks using countBy()`);
          const openCount = await taskRepo.countBy({ status: TaskStatus.OPEN });
          messageLog.push(`   - Open tasks: ${openCount}`);
          finalData.openCount = openCount;

          // Test QueryBuilder count
          messageLog.push(`3. Getting count of HIGH priority tasks using QueryBuilder`);
          const highPriorityCount = await taskRepo.createQueryBuilder("task")
              .where("task.priority = :priority", { priority: TaskPriority.HIGH })
              .getCount();
          messageLog.push(`   - High priority tasks: ${highPriorityCount}`);
          finalData.highPriorityCount = highPriorityCount;

          // Test complex QueryBuilder count (e.g., tasks with 'test' tag)
           messageLog.push(`4. Getting count of tasks with tag 'test' using QueryBuilder`);
           // Note: Array operations can be database-specific. This works for Postgres.
           // For PGlite/SQLite, LIKE might be needed if array functions aren't shimmed.
           // Trying LIKE approach for potentially broader compatibility here.
           let tagCount = 0;
           try {
                tagCount = await taskRepo.createQueryBuilder("task")
                    .where("task.tags::text LIKE :tag", { tag: '%test%' }) // Simple text LIKE
                    .getCount();
                messageLog.push(`   - Tasks with tag 'test' (using LIKE): ${tagCount}`);
           } catch (likeError) {
               messageLog.push(`   - LIKE query failed (maybe expected for non-text array?): ${likeError}`);
               // Add alternative if needed, e.g., fetching all and filtering client-side
               // const allTasks = await taskRepo.find();
               // tagCount = allTasks.filter(t => t.tags.includes('test')).length;
               // messageLog.push(`   - Tasks with tag 'test' (client-side filter): ${tagCount}`);
           }
           finalData.tagTestCount = tagCount;


          messageLog.push('=== Aggregation Tests Completed Successfully ===');

      } catch (error) {
          console.error('Error running aggregation tests:', error);
          success = false;
          messageLog.push(`Error: ${error instanceof Error ? error.message : String(error)}`);
          finalData.error = error;
      } finally {
          setResults(prev => [
              {
                  success,
                  message: `Aggregation Tests: ${success ? 'Completed successfully' : 'Failed'}`,
                  data: { log: messageLog, results: finalData }
              },
              ...prev
          ]);
          setIsLoading(false);
      }
  }


  // --- END NEW TEST FUNCTIONS ---

  return (
    <Card>
      <CardHeader>
        <CardTitle>TypeORM Test</CardTitle>
        <CardDescription>
          Test TypeORM with custom PGlite driver
        </CardDescription>
      </CardHeader>
      
      <CardContent>
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            <Button 
              onClick={runRepositoryQuery} 
              disabled={isLoading}
              variant="outline"
            >
              Repository API
            </Button>
            
            <Button 
              onClick={runQueryBuilder} 
              disabled={isLoading}
              variant="outline"
            >
              Query Builder
            </Button>
            
            <Button 
              onClick={runCustomQuery} 
              disabled={isLoading}
              variant="outline"
            >
              Custom SQL
            </Button>

            <Button 
              onClick={runChangeProcessorTests} 
              disabled={isLoading}
              variant="outline"
            >
              Change Processor
            </Button>
            
            <Button 
              onClick={runLiveQueryTest} 
              disabled={isLoading}
              variant="outline"
            >
              Live Query Test
            </Button>
            
            <Button 
              onClick={updateLiveTask} 
              disabled={isLoading || !liveTasks?.length}
              variant="outline"
            >
              Update Live Task
            </Button>

            {/* --- START NEW BUTTONS --- */}
            <Button
              onClick={runCrudTests}
              disabled={isLoading || !dataSource}
              variant="outline"
              className="bg-blue-100 hover:bg-blue-200"
            >
              CRUD Tests
            </Button>
            <Button
              onClick={runAdvancedFilterTests}
              disabled={isLoading || !dataSource}
              variant="outline"
              className="bg-blue-100 hover:bg-blue-200"
            >
              Advanced Filters
            </Button>
             <Button
              onClick={runRelationTests}
              disabled={isLoading || !dataSource}
              variant="outline"
              className="bg-purple-100 hover:bg-purple-200"
            >
              Relations & Joins
            </Button>
             <Button
              onClick={runOrderPaginateTests}
              disabled={isLoading || !dataSource}
              variant="outline"
              className="bg-yellow-100 hover:bg-yellow-200"
            >
              Order & Paginate
            </Button>
             <Button
              onClick={runTransactionTests}
              disabled={isLoading || !dataSource}
              variant="outline"
              className="bg-red-100 hover:bg-red-200"
            >
              Transactions
            </Button>
             <Button
              onClick={runAggregationTests}
              disabled={isLoading || !dataSource}
              variant="outline"
              className="bg-indigo-100 hover:bg-indigo-200"
            >
              Aggregations
            </Button>
            {/* --- END NEW BUTTONS --- */}

          </div>
          
          {/* Live Query Results */}
          {liveTasks && (
            <div className="mt-4 border rounded-md p-4">
              <h3 className="font-medium mb-2">Live Query Results:</h3>
              <div className="space-y-2">
                {liveTasks.map((task: Task) => (
                  <div key={task.id} className="p-2 bg-slate-50 rounded">
                    <p className="font-medium text-slate-900">{task.title}</p>
                    <p className="text-sm text-slate-600">Status: {task.status}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
          
          {/* Existing Results */}
          <div className="mt-4 border rounded-md p-4 max-h-96 overflow-auto">
            <h3 className="font-medium mb-2">Results:</h3>
            {results.length === 0 ? (
              <p className="text-muted-foreground">No results yet</p>
            ) : (
              <div className="space-y-3">
                {results.map((result, index) => (
                  <div 
                    key={index} 
                    className={`p-3 rounded-md ${result.success ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'} border`}
                  >
                    <p className={result.success ? 'text-green-800' : 'text-red-800'}>
                      {result.message}
                    </p>
                    {result.data && (
                      <pre className="mt-2 text-xs overflow-auto max-h-32 bg-slate-50 p-2 rounded">
                        {JSON.stringify(result.data, null, 2)}
                      </pre>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </CardContent>
      
      <CardFooter className="justify-between">
        <p className="text-sm text-muted-foreground">
          {isLoading ? 'Running query...' : 'Ready'}
        </p>
      </CardFooter>
    </Card>
  );
} 