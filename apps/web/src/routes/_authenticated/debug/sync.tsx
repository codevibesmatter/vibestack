import { createFileRoute } from '@tanstack/react-router';
import SyncPage from '@/features/debug/SyncPage';

export const Route = createFileRoute('/_authenticated/debug/sync')({
  component: SyncPage,
}); 