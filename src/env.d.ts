/// <reference types="astro/client" />

import type { AdminIdentity } from './lib/admin-auth';

declare global {
  namespace App {
    interface Locals {
      /** Set by middleware for any authenticated /admin request. */
      admin?: AdminIdentity;
    }
  }
}

export {};
