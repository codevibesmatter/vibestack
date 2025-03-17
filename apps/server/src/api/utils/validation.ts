import { z } from 'zod'

export const validationUtils = {
  schemas: {
    project: z.object({
      name: z.string(),
      description: z.string().optional(),
      status: z.enum(['active', 'archived', 'completed'])
    }),
    user: z.object({
      username: z.string(),
      email: z.string().email(),
      role: z.enum(['admin', 'user'])
    }),
    task: z.object({
      title: z.string(),
      description: z.string().optional(),
      status: z.enum(['todo', 'in_progress', 'done'])
    })
  }
} 