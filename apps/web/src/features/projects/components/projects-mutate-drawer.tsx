import { useForm } from 'react-hook-form';
import { showSubmittedData } from '@/utils/show-submitted-data';
import { Button } from '@/components/ui/button';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { SelectDropdown } from '@/components/select-dropdown';
import { Project, ProjectStatus } from '@repo/dataforge/client-entities';
import { useState, useEffect, useMemo } from 'react';
import { useProjects } from '../context/projects-context';
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentProject?: Project;
}

const projectFormSchema = z.object({
  name: z.string().min(2, {
    message: "Name must be at least 2 characters."
  }).max(100, {
    message: "Name cannot exceed 100 characters."
  }),
  description: z.string().max(5000, {
    message: "Description cannot exceed 5000 characters."
  }).optional(),
  status: z.nativeEnum(ProjectStatus)
});

type ProjectFormValues = z.infer<typeof projectFormSchema>;

export function ProjectsMutateDrawer({ open, onOpenChange, currentProject }: Props) {
  const isUpdate = !!currentProject;
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  
  // Get project service functions from context
  const { createProject, updateProject } = useProjects();

  const statusItems = useMemo(() => {
    return Object.values(ProjectStatus).map((status) => ({ // Removed type annotation for brevity, TS infers
      label: status.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase()),
      value: status,
    }));
  }, []); // ProjectStatus is constant, so this will compute only once

  const form = useForm<ProjectFormValues>({
    resolver: zodResolver(projectFormSchema),
    defaultValues: {
      name: currentProject?.name || '',
      description: currentProject?.description || '',
      status: currentProject?.status || ProjectStatus.ACTIVE,
    },
  });

  useEffect(() => {
    if (open) {
      if (currentProject) { // Editing an existing project
        form.reset({
          name: currentProject.name || '',
          description: currentProject.description || '',
          status: currentProject.status || ProjectStatus.ACTIVE,
        });
      } else { // Creating a new project
        form.reset({
          name: '',
          description: '',
          status: ProjectStatus.ACTIVE,
        });
      }
    }
  }, [open, currentProject, form]);

  const onSubmit = async (data: ProjectFormValues) => {
    setIsSaving(true);
    setSaveError(null);
    
    try {
      if (isUpdate && currentProject) {
        // Update existing project
        const updatedProject = await updateProject(currentProject.id, {
          name: data.name,
          description: data.description,
          status: data.status,
        });
        console.log("Project updated:", updatedProject);
      } else {
        // Create new project
        const newProject = await createProject({
          name: data.name,
          description: data.description,
          status: data.status,
        });
        console.log("Project created:", newProject);
      }

      form.reset();
      onOpenChange(false);
      showSubmittedData(data, isUpdate ? 'Project updated:' : 'Project created:');

    } catch (error) {
      console.error('Error saving project:', error);
      setSaveError(error instanceof Error ? error.message : "An unknown error occurred");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Sheet
      open={open}
      onOpenChange={(isOpen) => {
        onOpenChange(isOpen); // Propagate the change upwards
        if (!isOpen) { // If the sheet is being closed
          // Reset form to default "create" state, so it's fresh if opened again for "create"
          form.reset({
            name: '',
            description: '',
            status: ProjectStatus.ACTIVE,
          });
        }
      }}
    >
      <SheetContent className='flex flex-col'>
        <SheetHeader className='text-left'>
          <SheetTitle>{isUpdate ? 'Update' : 'Create'} Project</SheetTitle>
          <SheetDescription>
            {isUpdate
              ? 'Update the project by providing necessary info.'
              : 'Add a new project by providing necessary info.'}
            Click save when you're done.
          </SheetDescription>
        </SheetHeader>
        <Form {...form}>
          <form
            id='projects-form'
            onSubmit={form.handleSubmit(onSubmit)}
            className='flex-1 space-y-5 px-4'
          >
            <FormField
              control={form.control}
              name='name'
              render={({ field }) => (
                <FormItem className='space-y-1'>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder='Enter a name for the project' />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name='description'
              render={({ field }) => (
                <FormItem className='space-y-1'>
                  <FormLabel>Description</FormLabel>
                  <FormControl>
                    <Textarea 
                      {...field} 
                      placeholder='Enter a description' 
                      className="min-h-[100px]"
                      value={field.value || ''}
                    />
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
                    items={statusItems}
                  />
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
          <Button form='projects-form' type='submit' disabled={isSaving}>
            {isSaving ? 'Saving...' : 'Save changes'}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
} 