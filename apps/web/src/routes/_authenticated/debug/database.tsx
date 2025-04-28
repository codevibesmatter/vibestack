import { createFileRoute } from '@tanstack/react-router';
import DatabasePage from '@/features/debug/DatabasePage';

export const Route = createFileRoute('/_authenticated/debug/database')({
  component: DatabasePage,
}); 