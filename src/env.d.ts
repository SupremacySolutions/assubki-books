/// <reference types="astro/client" />

import type { AdminIdentity } from './lib/admin-auth';

declare global {
  namespace App {
    interface Locals {
      /** Set by middleware for any authenticated /admin request. */
      admin?: AdminIdentity;
      /**
       * Per-request nonce for inline scripts.
       *
       * Every `is:inline` block must carry it, or the browser refuses to run
       * that block - which is the point: an injected one will not have it.
       */
      cspNonce: string;
    }
  }
}

export {};
