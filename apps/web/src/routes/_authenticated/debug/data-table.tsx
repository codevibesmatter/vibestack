import { createFileRoute } from '@tanstack/react-router';
import DataTablePage from '@/features/debug/DataTablePage';

export const Route = createFileRoute('/_authenticated/debug/data-table')({
  component: DataTablePage,
}); 