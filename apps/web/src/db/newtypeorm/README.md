# Known Limitations - Custom PGlite TypeORM Driver

This document lists known limitations and issues discovered while testing the custom TypeORM driver (`NewPGliteDriver`, `NewPGliteDataSource`, `NewPGliteQueryRunner`) designed to work with PGlite.

## 1. Alias Inference Issue in Repository Update/Delete/Remove

**Issue:**
The standard TypeORM repository methods `.update()`, `.delete()`, and `.remove()` fail when used with the `NewPGliteDataSource`.

**Cause:**
These methods internally call the `DataSource.createQueryBuilder(EntityTarget)` method without explicitly providing an alias. The custom `NewPGliteDataSource.createQueryBuilder` implementation fails to correctly infer a default alias in this scenario, leading to a "Could not determine alias for createQueryBuilder" error.

**Workaround:**
Instead of using `repository.update()`, `repository.delete()`, or `repository.remove()`, use the `QueryBuilder` equivalent and provide an explicit alias:

```typescript
// Instead of: await taskRepo.update(id, { ... });
await taskRepo.createQueryBuilder('task_alias_update')
    .update(Task)
    .set({ ... })
    .where("id = :id", { id })
    .execute();

// Instead of: await taskRepo.delete(id);
await taskRepo.createQueryBuilder('task_alias_delete')
    .delete()
    .from(Task)
    .where("id = :id", { id })
    .execute();

// Instead of: await taskRepo.remove(taskInstance);
await taskRepo.createQueryBuilder('task_alias_remove')
    .delete()
    .from(Task)
    .where("id = :id", { id: taskInstance.id })
    .execute();
```

**Note:** `repository.save()` (for both create and update) and `repository.find*()` methods appear to work correctly.

## 2. Transaction Rollback on Error

**Issue:**
Transactions started using TypeORM's `dataSource.manager.transaction(async (entityManager) => { ... })` do **not** automatically roll back changes if an error is thrown within the transaction callback.

**Cause:**
The `NewPGliteQueryRunner` implements TypeORM's transaction interface by sending explicit `BEGIN`, `COMMIT`, and `ROLLBACK` commands via its general `query()` method. PGlite's documentation emphasizes using its native `pg.transaction(callback)` wrapper for reliable transaction management, which handles automatic rollbacks internally. Sending an explicit `query("ROLLBACK")` command after a preceding query within the transaction failed appears ineffective in PGlite.

**Impact:**
If an operation within a TypeORM-managed transaction fails, preceding successful operations within that same transaction block might be persisted instead of being rolled back.

**Workaround:**
Currently, there is no simple workaround other than avoiding errors within transaction blocks or implementing manual cleanup logic in error handlers. The robust solution would involve refactoring `NewPGliteQueryRunner` to use PGlite's native `pg.transaction(callback)` mechanism, but this is a complex change. 

---

# Overview and Usage

This section provides an overview of the custom TypeORM driver for PGlite, summarizes testing efforts, describes the files in this directory, and outlines recommended usage patterns.

## Summary of Testing & Development

*   **Goal:** To comprehensively test the custom TypeORM driver implementation (`@newtypeorm`) intended for use with PGlite in the browser.
*   **Testing Approach:** We expanded the existing `apps/web/src/features/dashboard/components/typeorm-test.tsx` component to include tests covering various TypeORM features:
    *   Basic Repository API & Query Builder
    *   Custom SQL Queries
    *   CRUD Operations (Create, Read, Update, Delete)
    *   Advanced Filtering (In, Between, Like, IsNull)
    *   Relations & Joins (Left/Inner Joins)
    *   Ordering & Pagination
    *   Transactions
    *   Aggregations (Count)
*   **Issues Discovered & Workarounds:**
    *   **Alias Inference:** Found that `repository.update()`, `.delete()`, and `.remove()` failed because the custom driver couldn't infer a query alias when these methods internally called `createQueryBuilder`. We worked around this in the test component by replacing these calls with explicit `QueryBuilder` equivalents, providing an alias manually. (See Limitation 1 above).
    *   **Transaction Rollback:** Discovered that transactions initiated via TypeORM's `dataSource.manager.transaction()` did not automatically roll back when an error occurred within the transaction callback. This is because the custom query runner sends manual `BEGIN`/`COMMIT`/`ROLLBACK` commands via its `query()` method, and PGlite doesn't reliably handle explicit `ROLLBACK` via `query()` after a prior error in the transaction. We modified the transaction test to verify this lack of rollback and perform manual cleanup. (See Limitation 2 above).

## File Descriptions

*   `README.md`: **(This file)** Documents known limitations, provides an overview, and outlines usage patterns.
*   `NewDataSource.ts`: Contains the factory function (`createNewPGliteDataSource` and the singleton getter `getNewPGliteDataSource`) for creating the custom TypeORM `DataSource` instance. It bridges configuration options to the custom driver and likely handles metadata building. It also contains the `createQueryBuilder` implementation where the alias inference issue originates.
*   `NewPGliteDriver.ts`: The core custom TypeORM `Driver` implementation. This class is responsible for connecting to PGlite, creating QueryRunners, and managing the overall interaction between TypeORM and the PGlite database instance.
*   `NewPGliteQueryRunner.ts`: Implements the TypeORM `QueryRunner` interface. It takes commands from TypeORM (like `query`, `startTransaction`, `commitTransaction`, `rollbackTransaction`) and executes them against PGlite using the `driver`. Currently uses explicit `BEGIN`/`COMMIT`/`ROLLBACK` commands via its `query` method for transactions, leading to the rollback issue.
*   `QueryBuilderFactory.ts`: A utility class to create `SelectQueryBuilder` instances directly. This might be used internally to avoid circular dependency issues between the DataSource and QueryRunner/QueryBuilder.
*   `TypeORMPatches.ts`: Contains functions that perform runtime patching on internal TypeORM classes (specifically `Broadcaster`) to prevent errors or adapt behavior for the custom driver.
*   `applyPatches.ts`: A utility function likely called during application startup to execute the patching functions defined in `TypeORMPatches.ts`.
*   `IMPLEMENTATION_PLAN.md`: Likely contains the original design notes and plan for creating this custom driver implementation.

## Usage Patterns & Recommendations

1.  **Initialization:** Obtain the DataSource instance using `getNewPGliteDataSource()`.
2.  **Basic Operations:** `repository.save()` (for creating and updating entities) and `repository.find*()` methods should work as expected.
3.  **Caveat: Update/Delete/Remove:** **Do not** use `repository.update()`, `repository.delete()`, or `repository.remove()`. Instead, **always** use the `QueryBuilder` approach with an explicit alias, as detailed in Limitation 1.
4.  **Caveat: Transactions:** While you can use `dataSource.manager.transaction()`, be aware that **changes will NOT be rolled back if an error occurs within the transaction block**. Design your application logic carefully around this limitation. Avoid operations that might throw errors within transactions if automatic rollback is critical, or implement manual compensating actions in your error handling. (See Limitation 2).
5.  **Patches:** Ensure the necessary patches are applied early in your application's lifecycle by calling the function in `applyPatches.ts` or the functions in `TypeORMPatches.ts` directly. 