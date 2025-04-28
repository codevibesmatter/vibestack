# Plan: SyncVisualizer Component

## 1. Purpose

To create a dynamic, animated visual representation of the real-time sync activity between the client application and the server. This component will provide users with immediate insight into the sync system's status, data flow, and potential issues.

## 2. Placement

-   The `SyncVisualizer` component will be developed within the `apps/shadadmin/src/features/sync/components/` directory (new directory).
-   It will replace the existing sync status card currently displayed on the main dashboard.
-   Target Dashboard File: `apps/shadadmin/src/features/dashboard/index.tsx` (or potentially a child component like `overview.tsx`).

## 3. Core Features & Visual Elements

-   **Client & Server Nodes:** Visual representations (icons/boxes) for the client and server.
-   **Connection Link:** An animated line connecting Client and Server, changing appearance based on `SyncState` and connection status (e.g., solid/dashed, color changes for connecting, live, catchup, error).
-   **Data Flow Animation:** Animated particles/arrows moving along the link:
    -   *Outgoing:* Triggered when sending change batches (`clt_send_changes`). Visual feedback for acknowledgment or error/timeout.
    -   *Incoming:* Triggered when receiving change batches. Visual feedback during processing and upon completion/error.
-   **Status Displays:**
    -   Current `SyncState` (e.g., 'Live', 'Catchup', 'Disconnected').
    -   Number of pending outgoing changes.
    -   Current client LSN.
    -   Indicator for active errors.
-   **Animation:** Utilize `Framer Motion` for fluid transitions and data flow animations.

## 4. Data & Event Handling

-   **Primary State:** Leverage `useSyncContext` for basic `isConnected`, `syncState`, `pendingChanges`.
-   **Detailed Events:** Establish direct listeners (within `useEffect`) to `SyncManager` and `SyncChangeManager` singletons for:
    -   `SyncManager`: `stateChange`, `connected`, `disconnected`, `reconnecting`, `error`, `messageSent`, `messageReceived`, `lsnUpdate`, `initialSyncProgress`, `catchupSyncProgress`, `changesReceived`, `changesProcessed`.
    -   `SyncChangeManager`: `change_created`, `change_acknowledged`, `change_timeout`, `change_error`, `incoming_changes_processed`.
-   **State Management:** Use component local state (`useState`) to track LSN, animation triggers, error details, and potentially event logs based on the received events.
-   **Cleanup:** Ensure all event listeners are removed in the `useEffect` cleanup function to prevent memory leaks.

## 5. Implementation Steps

1.  **Install Framer Motion:** Add `framer-motion` as a project dependency.
2.  **Create Directory:** Create `apps/shadadmin/src/features/sync/components/`.
3.  **Component Skeleton:** Create `SyncVisualizer.tsx` in the new directory with basic structure and `useSyncContext`.
4.  **Event Listeners:** Implement `useEffect` hook to subscribe/unsubscribe to relevant `SyncManager` and `SyncChangeManager` events. Add state variables to hold data derived from events.
5.  **Static Layout:** Build the static layout with Client node, Server node, and a placeholder connection link using standard React/Tailwind/Shadcn UI components. Display basic context/state info.
6.  **Animate Connection Link:** Use `motion` components from Framer Motion to animate the link's appearance based on `isConnected` and `syncState`.
7.  **Animate Data Flow:** Implement the animated particles/arrows for outgoing/incoming data flow, triggered by the corresponding event handlers.
8.  **Refine Visuals:** Polish the animations, transitions, and overall appearance.
9.  **Integrate into Dashboard:** Replace the existing sync card in `apps/shadadmin/src/features/dashboard/index.tsx` (or relevant child) with the new `SyncVisualizer` component.
10. **Testing:** Test thoroughly across different sync states, connection scenarios, and error conditions.

## 6. Future Considerations (Optional)

-   Add a small, scrollable log of recent sync events.
-   Provide controls to manually trigger connect/disconnect or reset LSN (for debugging).
-   Display server-side LSN if available. 