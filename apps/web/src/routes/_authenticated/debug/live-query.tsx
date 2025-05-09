import LiveQueryDebugPage from '@/features/debug/LiveQueryDebugPage';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_authenticated/debug/live-query')({
  component: LiveQueryDebugPage,
}); 