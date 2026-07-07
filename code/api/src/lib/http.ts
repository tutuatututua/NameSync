import type { Pagination } from "@extensions/contract";

/** `{ success:true, message?, data }` */
export const ok = <T>(data: T, message?: string) =>
  ({ success: true as const, ...(message ? { message } : {}), data });

/** `{ success:true, data:[], pagination }` */
export const okList = <T>(data: T[], pagination: Pagination) =>
  ({ success: true as const, data, pagination });

/** `{ success:true, message }` */
export const okMessage = (message: string) => ({ success: true as const, message });
