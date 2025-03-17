import { faker } from '@faker-js/faker';
import serverDataSource from '../datasources/server.js';
import { User, UserRole, Project, ProjectStatus, Task, TaskStatus, TaskPriority, Comment } from '../server-entities.js';

// Configuration
const CONFIG = {
  users: 10,
  projectsPerUser: 2,
  tasksPerProject: 5,
  commentsPerTask: 2,
  memberOverlapPercent: 30, // % chance of a user being a member of another's project
  assigneeOverlapPercent: 40 // % chance of a task being assigned to a project member
};

/**
 * Generate seed data for testing
 */
export async function generateSeedData() {
  const dataSource = await serverDataSource.initialize();
  
  try {
    // Clear existing data
    await dataSource.query('TRUNCATE users, projects, tasks, comments CASCADE');
    
    // Create users
    const users = await createUsers(dataSource);
    console.log(`Created ${users.length} users`);
    
    // Create projects with tasks and comments
    const projects = await createProjects(dataSource, users);
    console.log(`Created ${projects.length} projects`);
    
    return {
      users,
      projects
    };
  } finally {
    await dataSource.destroy();
  }
}

/**
 * Create test users
 */
async function createUsers(dataSource: typeof serverDataSource): Promise<User[]> {
  const userRepo = dataSource.getRepository(User);
  const users: User[] = [];
  
  // Create one admin user
  const admin = new User();
  admin.name = 'Admin User';
  admin.email = 'admin@example.com';
  admin.role = UserRole.ADMIN;
  admin.avatar_url = faker.image.avatar();
  users.push(admin);
  
  // Create regular users
  for (let i = 0; i < CONFIG.users - 1; i++) {
    const user = new User();
    user.name = faker.person.fullName();
    user.email = faker.internet.email();
    user.role = UserRole.MEMBER;
    user.avatar_url = faker.image.avatar();
    users.push(user);
  }
  
  // Save all users
  return userRepo.save(users);
}

/**
 * Create test projects with tasks and comments
 */
async function createProjects(dataSource: typeof serverDataSource, users: User[]): Promise<Project[]> {
  const projectRepo = dataSource.getRepository(Project);
  const projects: Project[] = [];
  
  // Each user creates some projects
  for (const user of users) {
    for (let i = 0; i < CONFIG.projectsPerUser; i++) {
      const project = new Project();
      project.name = faker.company.catchPhrase();
      project.description = faker.lorem.paragraph();
      project.status = faker.helpers.arrayElement(Object.values(ProjectStatus));
      project.owner = user;
      project.owner_id = user.id;
      
      // Add random members
      project.members = [user];
      for (const potentialMember of users) {
        if (potentialMember.id !== user.id && Math.random() * 100 < CONFIG.memberOverlapPercent) {
          project.members.push(potentialMember);
        }
      }
      
      // Save project to get ID
      const savedProject = await projectRepo.save(project);
      
      // Create tasks for this project
      const tasks = await createTasks(dataSource, savedProject, project.members);
      
      // Create comments for tasks
      await createComments(dataSource, tasks, project.members);
      
      projects.push(savedProject);
    }
  }
  
  return projects;
}

/**
 * Create test tasks for a project
 */
async function createTasks(
  dataSource: typeof serverDataSource, 
  project: Project, 
  projectMembers: User[]
): Promise<Task[]> {
  const taskRepo = dataSource.getRepository(Task);
  const tasks: Task[] = [];
  
  for (let i = 0; i < CONFIG.tasksPerProject; i++) {
    const task = new Task();
    task.title = faker.hacker.phrase().substring(0, 100);
    task.description = faker.lorem.paragraphs(2);
    task.status = faker.helpers.arrayElement(Object.values(TaskStatus));
    task.priority = faker.helpers.arrayElement(Object.values(TaskPriority));
    task.project = project;
    task.project_id = project.id;
    task.tags = Array.from({ length: faker.number.int({ min: 0, max: 3 }) }, 
      () => faker.hacker.adjective()
    );
    
    // Set due date for some tasks
    if (Math.random() > 0.3) {
      task.due_date = faker.date.future();
    }
    
    // Set completed date for completed tasks
    if (task.status === TaskStatus.COMPLETED) {
      task.completed_at = faker.date.past();
    }
    
    // Randomly assign to project member
    if (Math.random() * 100 < CONFIG.assigneeOverlapPercent) {
      const assignee = faker.helpers.arrayElement(projectMembers);
      task.assignee = assignee;
      task.assignee_id = assignee.id;
    }
    
    tasks.push(task);
  }
  
  return taskRepo.save(tasks);
}

/**
 * Create test comments for tasks
 */
async function createComments(
  dataSource: typeof serverDataSource,
  tasks: Task[], 
  projectMembers: User[]
): Promise<Comment[]> {
  const commentRepo = dataSource.getRepository(Comment);
  const comments: Comment[] = [];
  
  for (const task of tasks) {
    for (let i = 0; i < CONFIG.commentsPerTask; i++) {
      const comment = new Comment();
      comment.content = faker.lorem.paragraph();
      comment.entityType = 'task';
      comment.entityId = task.id;
      comment.authorId = faker.helpers.arrayElement(projectMembers).id;
      
      // 20% chance of being a reply to another comment
      if (i > 0 && Math.random() < 0.2) {
        comment.parentId = comments[comments.length - 1].id;
      }
      
      comments.push(comment);
    }
  }
  
  return commentRepo.save(comments);
}

// Run the seed if this file is executed directly
if (process.argv[1].endsWith('seed.ts')) {
  generateSeedData()
    .then(() => {
      console.log('✅ Seed data generated successfully');
      process.exit(0);
    })
    .catch(error => {
      console.error('❌ Error generating seed data:', error);
      process.exit(1);
    });
} 