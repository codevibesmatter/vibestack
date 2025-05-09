import { useForm } from 'react-hook-form'
import { showSubmittedData } from '@/utils/show-submitted-data'
import { Button } from '@/components/ui/button'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { SelectDropdown } from '@/components/select-dropdown'
import { Task, TaskStatus, TaskPriority, Project } from '@repo/dataforge/client-entities'
import { useState, useEffect } from 'react'
import { useTasks } from '../context/tasks-context'
import { zodResolver } from "@hookform/resolvers/zod"
import * as z from "zod"
import { useProjects } from '@/db/hooks'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  currentRow?: Task
}

const taskFormSchema = z.object({
  title: z.string().min(1, "Title cannot be empty").max(100, "Title cannot exceed 100 characters"),
  description: z.string().max(5000, "Description cannot exceed 5000 characters").optional(),
  status: z.nativeEnum(TaskStatus),
  priority: z.nativeEnum(TaskPriority),
  projectId: z.string().uuid("Please select a valid project"),
});

type TasksFormValues = z.infer<typeof taskFormSchema>;

export function TasksMutateDrawer({ open, onOpenChange, currentRow }: Props) {
  const isUpdate = !!currentRow
  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  
  const { createTask, updateTask } = useTasks()
  
  const { projects: availableProjects, isLoading: isLoadingProjects } = useProjects();

  const form = useForm<TasksFormValues>({
    resolver: zodResolver(taskFormSchema),
    defaultValues: {
      title: currentRow?.title || '',
      status: currentRow?.status || TaskStatus.OPEN,
      priority: currentRow?.priority || TaskPriority.MEDIUM,
      description: currentRow?.description || '',
      projectId: currentRow?.projectId || ''
    },
  })

  useEffect(() => {
    form.reset({
      title: currentRow?.title || '',
      status: currentRow?.status || TaskStatus.OPEN,
      priority: currentRow?.priority || TaskPriority.MEDIUM,
      description: currentRow?.description || '',
      projectId: currentRow?.projectId || ''
    });
  }, [currentRow, form]);

  const onSubmit = async (data: TasksFormValues) => {
    setIsSaving(true)
    setSaveError(null)
    console.log("Saving task data:", data)
    
    try {
      if (isUpdate && currentRow) {
        const updatedTask = await updateTask(currentRow.id, {
          title: data.title,
          status: data.status,
          priority: data.priority,
          description: data.description,
          projectId: data.projectId
        });
        console.log("Task updated:", updatedTask);
      } else {
        const newTask = await createTask({
          title: data.title,
          status: data.status,
          priority: data.priority,
          description: data.description,
          projectId: data.projectId,
        });
        console.log("Task created:", newTask);
      }

      console.log("Save successful")

      form.reset()
      onOpenChange(false)
      showSubmittedData(data, isUpdate ? 'Task updated:' : 'Task created:')

    } catch (error) {
      console.error('Error saving task:', error)
      setSaveError(error instanceof Error ? error.message : "An unknown error occurred")
    } finally {
      setIsSaving(false)
    }
  }

  const projectOptions = availableProjects?.map(project => ({ 
    label: project.name,
    value: project.id 
  })) || [];

  return (
    <Sheet
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          form.reset();
          setSaveError(null);
        }
        onOpenChange(v)
      }}
    >
      <SheetContent className='flex flex-col'>
        <SheetHeader className='text-left'>
          <SheetTitle>{isUpdate ? 'Update' : 'Create'} Task</SheetTitle>
          <SheetDescription>
            {isUpdate
              ? 'Update the task by providing necessary info.'
              : 'Add a new task by providing necessary info.'}
            Click save when you&apos;re done.
          </SheetDescription>
        </SheetHeader>
        <Form {...form}>
          <form
            id='tasks-form'
            onSubmit={form.handleSubmit(onSubmit)}
            className='flex-1 space-y-5 overflow-y-auto px-1 py-2'
          >
            <FormField
              control={form.control}
              name='title'
              render={({ field }) => (
                <FormItem className='space-y-1'>
                  <FormLabel>Title</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder='Enter a title' />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="projectId"
              render={({ field }) => (
                <FormItem className='space-y-1'>
                  <FormLabel>Project</FormLabel>
                  <SelectDropdown
                    defaultValue={field.value}
                    onValueChange={field.onChange}
                    placeholder='Select project'
                    items={projectOptions}
                    disabled={isLoadingProjects}
                  />
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name='status'
              render={({ field }) => (
                <FormItem className='space-y-1'>
                  <FormLabel>Status</FormLabel>
                  <SelectDropdown
                    defaultValue={field.value}
                    onValueChange={field.onChange}
                    placeholder='Select status'
                    items={Object.values(TaskStatus).map((status: TaskStatus) => ({
                      label: status.replace('_', ' ').replace(/\b\w/g, (l: string) => l.toUpperCase()),
                      value: status,
                    }))}
                  />
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name='priority'
              render={({ field }) => (
                <FormItem className='relative space-y-3'>
                  <FormLabel>Priority</FormLabel>
                  <FormControl>
                    <RadioGroup
                      onValueChange={field.onChange}
                      defaultValue={field.value}
                      className='flex flex-col space-y-1'
                    >
                      {Object.values(TaskPriority).map((priority: TaskPriority) => (
                        <FormItem key={priority} className='flex items-center space-y-0 space-x-3'>
                          <FormControl>
                            <RadioGroupItem value={priority} />
                          </FormControl>
                          <FormLabel className='font-normal'>
                            {priority.charAt(0).toUpperCase() + priority.slice(1)}
                          </FormLabel>
                        </FormItem>
                      ))}
                    </RadioGroup>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            {saveError && (
              <p className="text-sm font-medium text-destructive">Error: {saveError}</p>
            )}
          </form>
        </Form>
        <SheetFooter className='mt-auto gap-2'>
          <SheetClose asChild>
            <Button variant='outline' disabled={isSaving}>Close</Button>
          </SheetClose>
          <Button form='tasks-form' type='submit' disabled={isSaving}>
            {isSaving ? 'Saving...' : 'Save changes'}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
