import { useState } from 'react'
import { showSubmittedData } from '@/utils/show-submitted-data'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { useTasks } from '../context/tasks-context'
import { TasksImportDialog } from './tasks-import-dialog'
import { TasksMutateDrawer } from './tasks-mutate-drawer'

export function TasksDialogs() {
  const { open, setOpen, currentRow, setCurrentRow, deleteTask } = useTasks()
  const [isDeleting, setIsDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const handleDeleteTask = async () => {
    if (!currentRow) return;
    
    setIsDeleting(true);
    setDeleteError(null);
    
    try {
      const success = await deleteTask(currentRow.id);
      
      if (success) {
        setOpen(null);
        setTimeout(() => {
          setCurrentRow(null);
        }, 500);
        showSubmittedData(
          currentRow,
          'The following task has been deleted:'
        );
      } else {
        setDeleteError("Failed to delete task");
      }
    } catch (error) {
      console.error("Error deleting task:", error);
      setDeleteError(error instanceof Error ? error.message : "An unknown error occurred");
    } finally {
      setIsDeleting(false);
    }
  }

  return (
    <>
      <TasksMutateDrawer
        key='task-create'
        open={open === 'create'}
        onOpenChange={() => setOpen('create')}
      />

      <TasksImportDialog
        key='tasks-import'
        open={open === 'import'}
        onOpenChange={() => setOpen('import')}
      />

      {currentRow && (
        <>
          <TasksMutateDrawer
            key={`task-update-${currentRow.id}`}
            open={open === 'update'}
            onOpenChange={() => {
              setOpen('update')
              setTimeout(() => {
                setCurrentRow(null)
              }, 500)
            }}
            currentRow={currentRow}
          />

          <ConfirmDialog
            key='task-delete'
            destructive
            open={open === 'delete'}
            onOpenChange={() => {
              setOpen('delete')
              setTimeout(() => {
                setCurrentRow(null)
              }, 500)
            }}
            handleConfirm={handleDeleteTask}
            className='max-w-md'
            title={`Delete this task: ${currentRow.title} ?`}
            desc={
              <>
                You are about to delete a task with the title{' '}
                <strong>{currentRow.title}</strong>. <br />
                This action cannot be undone.
                {deleteError && (
                  <p className="mt-2 text-sm font-medium text-destructive">
                    Error: {deleteError}
                  </p>
                )}
              </>
            }
            confirmText={isDeleting ? 'Deleting...' : 'Delete'}
            disabled={isDeleting}
          />
        </>
      )}
    </>
  )
}
