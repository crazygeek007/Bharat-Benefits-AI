'use server';

/**
 * Server actions for the flagged-schemes admin page (Req 17.5, 17.6).
 *
 * Wraps the admin API approve/reject endpoints so the page can post
 * forms without shipping a bunch of client-side fetch logic. Each
 * action revalidates the flags listing so the UI reflects the
 * post-approval/rejection state immediately.
 */

import { revalidatePath } from 'next/cache';
import { getAdminAuthContext } from '../../../lib/admin-auth';
import {
  approveAdminFlag,
  rejectAdminFlag,
} from '../../../lib/admin-api';

export interface FlagActionResult {
  ok: boolean;
  message: string;
}

export async function approveFlagAction(
  flagId: string,
  note?: string,
): Promise<FlagActionResult> {
  if (!flagId) return { ok: false, message: 'Missing flag id' };
  const { authHeader, isAuthenticated } = await getAdminAuthContext();
  if (!isAuthenticated) {
    return { ok: false, message: 'Sign in required' };
  }
  const result = await approveAdminFlag(authHeader, flagId, note);
  if (!result.ok) {
    return { ok: false, message: result.message };
  }
  revalidatePath('/admin/flags');
  revalidatePath('/admin');
  return { ok: true, message: 'Flag approved' };
}

export async function rejectFlagAction(
  flagId: string,
  reason: string,
): Promise<FlagActionResult> {
  if (!flagId) return { ok: false, message: 'Missing flag id' };
  if (!reason || reason.trim() === '') {
    return { ok: false, message: 'Rejection reason is required' };
  }
  const { authHeader, isAuthenticated } = await getAdminAuthContext();
  if (!isAuthenticated) {
    return { ok: false, message: 'Sign in required' };
  }
  const result = await rejectAdminFlag(authHeader, flagId, reason.trim());
  if (!result.ok) {
    return { ok: false, message: result.message };
  }
  revalidatePath('/admin/flags');
  revalidatePath('/admin');
  return { ok: true, message: 'Flag rejected' };
}
