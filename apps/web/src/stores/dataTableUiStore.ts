// In apps/web/src/stores/dataTableUiStore.ts
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import {
  SortingState,
  VisibilityState,
  ColumnOrderState,
  ColumnSizingState,
  ColumnFiltersState,
  PaginationState,
} from '@tanstack/react-table';

export interface DataTableUIState {
  sorting?: SortingState;
  columnVisibility?: VisibilityState;
  columnOrder?: ColumnOrderState;
  columnSizing?: ColumnSizingState; // For column widths
  columnFilters?: ColumnFiltersState;
  pagination?: Pick<PaginationState, 'pageIndex' | 'pageSize'>; // Persist only pageIndex and pageSize
}

export interface AllDataTableUIStates {
  [tableId: string]: DataTableUIState; // Keyed by tableId
}

interface DataTableUiActions {
  getUiState: (tableId: string) => DataTableUIState | undefined;
  setUiState: (tableId: string, newState: Partial<DataTableUIState>) => void;
  resetUiState: (tableId: string) => void;
}

export const useDataTableUiStore = create<AllDataTableUIStates & DataTableUiActions>()(
  persist(
    (set, get) => ({
      // Initial state for AllDataTableUIStates is implicitly {} by persist middleware if not found in storage
      // or if you want to be explicit and ensure it's always an object even if storage is corrupted:
      // ...{} as AllDataTableUIStates, // This line is not strictly needed due to how persist works

      getUiState: (tableId: string) => {
        return get()[tableId];
      },
      setUiState: (tableId: string, newState: Partial<DataTableUIState>) => {
        set((state) => ({
          ...state,
          [tableId]: {
            ...(state[tableId] || {}),
            ...newState,
          },
        }));
      },
      resetUiState: (tableId: string) => {
        set((state) => {
          const { [tableId]: _, ...rest } = state;
          // It's important to also remove the actions from the spread to avoid them being part of the persisted state.
          // However, `persist` middleware typically handles this by only persisting the state part.
          // A more robust way to ensure only AllDataTableUIStates properties are considered for deletion:
          const newState = { ...state };
          delete newState[tableId]; // Remove the specific table's UI state
          // Remove action properties if they were somehow included in `state` before spreading `rest`
          // This is more of a safeguard, as `set` should operate on the state slice.
          delete (newState as any).getUiState;
          delete (newState as any).setUiState;
          delete (newState as any).resetUiState;
          return newState;
        });
      },
    }),
    {
      name: 'dataTable-ui-storage', // localStorage key
      storage: createJSONStorage(() => localStorage),
      // Partialize to ensure actions are not persisted
      partialize: (state) => {
        const { getUiState, setUiState, resetUiState, ...rest } = state;
        return rest;
      }
    }
  )
);