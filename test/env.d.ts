/// <reference types="@cloudflare/vitest-pool-workers/types" />

declare module "*?raw" {
  const content: string;
  export default content;
}
