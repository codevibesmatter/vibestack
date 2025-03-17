/// <reference types="vite/client" />

// SQL file imports
declare module '*.sql?raw' {
  const content: string;
  export default content;
}

// Enable experimental decorators


