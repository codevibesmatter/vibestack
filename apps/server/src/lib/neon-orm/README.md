# TypeORM Integration for Neon Serverless & Cloudflare Workers

This directory contains a custom TypeORM integration layer designed to work with the `@neondatabase/serverless` driver within the Cloudflare Workers environment. Standard TypeORM setup often relies on Node.js-specific APIs (like filesystem access for config or `app-root-path` for module location) and assumes persistent database connections, which are incompatible with the Workers runtime and the Neon serverless driver model.

## Key Components

1.  **`NeonDriver.ts`**:
    *   Implements the TypeORM `Driver` interface.
    *   Mimics the behavior of the standard `postgres` driver where possible for compatibility.
    *   Crucially, it **does not** manage a persistent database client instance. Connection handling is delegated entirely to the `NeonQueryRunner`.
    *   Provides necessary methods and properties expected by TypeORM's core.

2.  **`NeonQueryRunner.ts`**:
    *   Implements the TypeORM `QueryRunner` interface.
    *   Its primary responsibility is executing queries (`query` method).
    *   For **each** query execution, it:
        *   Creates a *new* `Client` instance from `@neondatabase/serverless` using the connection URL.
        *   Connects the client (`client.connect()`).
        *   Executes the SQL query (`client.query(query, parameters)`).
        *   Disconnects the client (`client.end()`).
    *   This per-query connection model is essential for compatibility with Neon's serverless connection pooling and the ephemeral nature of Workers.
    *   Methods related to schema manipulation (e.g., `createTable`, `dropTable`, `addColumn`) are generally **not implemented**, as migrations are expected to be handled separately outside the runtime application.

3.  **`NeonDataSource.ts`**:
    *   Exports a factory function `createNeonDataSource(options: NeonDataSourceOptions): NeonDataSource`.
    *   This function constructs a custom object (`NeonDataSource`) that adheres to the structure TypeORM expects internally but bypasses the standard `new DataSource()` constructor.
    *   It manually instantiates the `NeonDriver`, builds entity metadata (`buildMetadatas`), creates the `EntityManager`, and wires them together.
    *   This avoids parts of the standard TypeORM initialization that fail in the Workers environment.
    *   This factory is intended to be called by an application-level singleton manager (like `getDataSource` in `../../data-source.ts`) which handles configuration and ensures only one instance is created and initialized.

4.  **`neon-service.ts`**:
    *   A simple wrapper service class (`NeonService`).
    *   It retrieves the initialized `NeonDataSource` singleton instance (via `getDataSource` from `../../data-source.ts`).
    *   Uses the `EntityManager` from the `NeonDataSource` to provide common data access methods (`find`, `findOne`, `insert`, `update`, `delete`, `createQueryBuilder`).

## Handling `app-root-path` Incompatibility

A major challenge is that TypeORM internally (and sometimes indirectly via dependencies) uses the `app-root-path` module to locate project files (e.g., for configuration loading). This module relies on Node.js globals (`module.filename`, etc.) that do not exist in Cloudflare Workers, causing crashes during initialization.

Runtime patching proved unreliable because the module often crashes *before* the patch can be applied. The solution implemented is **bundler aliasing**:

1.  **Shim File**: A simple shim file (`apps/server/src/lib/app-root-path-shim.ts`) was created. It exports an object with the same structure as `app-root-path` but provides dummy values or no-op functions compatible with the Workers environment.

2.  **Wrangler Alias**: The `wrangler.toml` configuration file tells the bundler (esbuild) to replace any import or require request for `app-root-path` with our shim file:

    ```toml
    # apps/server/wrangler.toml
    [alias]
    "app-root-path" = "./src/lib/app-root-path-shim.ts"
    ```

This ensures that when TypeORM tries to load `app-root-path`, it receives our harmless shim instead of the incompatible original module, preventing runtime errors.

## Usage

The application initializes and accesses the database connection through the `getDataSource` function located in `apps/server/src/lib/data-source.ts`. This function acts as a singleton provider:

*   It calls the `createNeonDataSource` factory from `NeonDataSource.ts`.
*   It handles asynchronous initialization (`.initialize()`).
*   It retrieves necessary configuration (like `DATABASE_URL`) from the execution context (e.g., Hono context `c.env`).
*   It ensures only one `NeonDataSource` instance exists for the application lifetime.

Services like `NeonService` then use `getDataSource` to obtain the initialized instance and perform database operations via its `EntityManager`. This overall setup ensures that TypeORM operations use the custom driver and query runner compatible with Neon Serverless and Cloudflare Workers. 