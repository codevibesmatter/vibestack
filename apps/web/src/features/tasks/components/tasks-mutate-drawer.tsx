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
import { Task, TaskStatus, TaskPriority } from '@repo/dataforge'
import { getNewPGliteDataSource } from '@/db/newtypeorm/NewDataSource'
import { useState } from 'react'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  currentRow?: Task
}

type TasksForm = Pick<Task, 'title' | 'status' | 'priority'> & { description?: string }

export function TasksMutateDrawer({ open, onOpenChange, currentRow }: Props) {
  const isUpdate = !!currentRow
  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const form = useForm<TasksForm>({
    defaultValues: {
      title: currentRow?.title || '',
      status: currentRow?.status || TaskStatus.OPEN,
      priority: currentRow?.priority || TaskPriority.MEDIUM,
      description: currentRow?.description || ''
    },
  })

  const onSubmit = async (data: TasksForm) => {
    setIsSaving(true)
    setSaveError(null)
    console.log("Saving task data:", data)
    
    try {
      const dataSource = await getNewPGliteDataSource()
      const taskRepo = dataSource.getRepository(Task)
      
      if (isUpdate && currentRow) {
        // --- Load existing entity first ---
        const existingTask = await taskRepo.findOneBy({ id: currentRow.id });
        if (!existingTask) {
          throw new Error("Task not found for update");
        }
        // Apply form changes to the loaded entity
        existingTask.title = data.title;
        existingTask.status = data.status;
        existingTask.priority = data.priority;
        existingTask.description = data.description;
        // Do NOT manually set existingTask.updatedAt here

        console.log(">>> [Before Save] Loaded entity being passed to taskRepo.save:", JSON.stringify(existingTask, null, 2));
        const savedTask = await taskRepo.save(existingTask); // Save the full loaded entity
        console.log(">>> [After Save] Result returned by taskRepo.save (full entity):", JSON.stringify(savedTask, null, 2));
        // The savedTask already contains the updated_at value, no need for manual check
      } else {
        // --- Original creation logic ---
        const dataToSave: Partial<Task> = { ...data }; // Keep original dataToSave for creation
        console.log(">>> [Before Save] New data being passed to taskRepo.save:", JSON.stringify(dataToSave, null, 2));
        const savedTask = await taskRepo.save(dataToSave as any); // Capture result
        console.log(">>> [After Save] Result returned by taskRepo.save (new entity):", JSON.stringify(savedTask, null, 2));
        // --- End original creation logic ---
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

  return (
    <Sheet
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v)
        form.reset()
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
            className='flex-1 space-y-5 px-4'
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
              name='status'
              render={({ field }) => (
                <FormItem className='space-y-1'>
                  <FormLabel>Status</FormLabel>
                  <SelectDropdown
                    defaultValue={field.value}
                    onValueChange={field.onChange}
                    placeholder='Select status'
                    items={Object.values(TaskStatus).map(status => ({
                      label: status.replace('_', ' ').replace(/\b\w/g, l => l.toUpperCase()),
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
                      {Object.values(TaskPriority).map(priority => (
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
        <SheetFooter className='gap-2'>
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
