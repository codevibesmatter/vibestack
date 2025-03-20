import { faker } from '@faker-js/faker';
import { v4 as uuidv4 } from 'uuid';
import { 
  Task, TaskStatus, TaskPriority,
  Project, ProjectStatus,
  User, UserRole,
  Comment
} from '@repo/dataforge/server-entities';

type Entity = Task | Project | User | Comment;
type EntityClass = typeof Task | typeof Project | typeof User | typeof Comment;

/**
 * Generate fake data for an entity
 */
export async function generateFakeData(entityClass: EntityClass): Promise<Record<string, unknown>> {
  switch(entityClass) {
    case Task:
      return {
        id: uuidv4(),
        title: faker.hacker.phrase().substring(0, 100),
        description: faker.lorem.paragraphs(2),
        status: faker.helpers.arrayElement(Object.values(TaskStatus)),
        priority: faker.helpers.arrayElement(Object.values(TaskPriority)),
        due_date: Math.random() > 0.3 ? faker.date.future() : null,
        completed_at: Math.random() > 0.7 ? faker.date.past() : null,
        tags: Array.from({ length: faker.number.int({ min: 0, max: 5 }) }, 
          () => faker.hacker.adjective()
        ),
        project_id: uuidv4(),
        assignee_id: Math.random() > 0.4 ? uuidv4() : null,
        created_at: faker.date.past(),
        updated_at: new Date()
      };

    case Project:
      return {
        id: uuidv4(),
        name: faker.company.catchPhrase(),
        description: faker.lorem.paragraph(),
        status: faker.helpers.arrayElement(Object.values(ProjectStatus)),
        owner_id: uuidv4(),
        created_at: faker.date.past(),
        updated_at: new Date()
      };

    case User:
      return {
        id: uuidv4(),
        name: faker.person.fullName(),
        email: faker.internet.email(),
        role: faker.helpers.arrayElement(Object.values(UserRole)),
        avatar_url: faker.image.avatar(),
        created_at: faker.date.past(),
        updated_at: new Date()
      };

    case Comment:
      return {
        id: uuidv4(),
        content: faker.lorem.paragraph(),
        entityType: 'task',
        entityId: uuidv4(),
        authorId: uuidv4(),
        parentId: Math.random() > 0.6 ? uuidv4() : null,
        created_at: faker.date.past(),
        updated_at: new Date()
      };

    default:
      throw new Error(`Unknown entity type: ${entityClass.name}`);
  }
} 