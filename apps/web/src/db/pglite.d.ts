declare module '@electric-sql/pglite/worker' {
  export const worker: (options: {
    init: () => Promise<any>;
  }) => void;
}

declare module '@electric-sql/pglite/contrib/uuid_ossp' {
  export const uuid_ossp: any;
}

declare module '@electric-sql/pglite/live' {
  export const live: any;
} 