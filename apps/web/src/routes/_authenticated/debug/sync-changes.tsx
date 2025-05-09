import { createFileRoute } from '@tanstack/react-router';
import { SyncChangesPage } from '@/features/debug/SyncChangesPage';

export const Route = createFileRoute('/_authenticated/debug/sync-changes')({
  component: SyncChangesPage,
}); 