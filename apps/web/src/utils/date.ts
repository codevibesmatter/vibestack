/**
 * Formats a date string into a localized string with date and time
 */
export function formatDate(dateString: string): string {
  if (!dateString) return '-';
  const date = new Date(dateString);
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
} 