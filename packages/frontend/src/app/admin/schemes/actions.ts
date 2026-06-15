'use server';

/**
 * Server actions for the scheme-management admin page (Req 17.2).
 *
 * Wraps the admin API verify/edit/remove endpoints with thin server
 * actions so the page form can post directly without a custom client
 * fetch helper. Each successful action revalidates the scheme listing
 * so the UI reflects the post-modification state.
 */

import { revalidatePath } from 'next/cache';
import { getAdminAuthContext } from '../../../lib/admin-auth';
import {
  editAdminScheme,
  removeAdminScheme,
  verifyAdminScheme,
} from '../../../lib/admin-api';

export interface SchemeActionResult {
  ok: boolean;
  message: string;
}

export async function verifySchemeAction(
  schemeId: string,
  note?: string,
): Promise<SchemeActionResult> {
  const { authHeader, isAuthenticated } = await getAdminAuthContext();
  if (!isAuthenticated) return { ok: false, message: 'Sign in required' };
  const result = await verifyAdminScheme(authHeader, schemeId, note);
  if (!result.ok) return { ok: false, message: result.message };
  revalidatePath('/admin/schemes');
  revalidatePath('/admin');
  return { ok: true, message: 'Scheme verified' };
}

export async function editSchemeAction(
  schemeId: string,
  patch: Record<string, unknown>,
  note?: string,
): Promise<SchemeActionResult> {
  if (!patch || Object.keys(patch).length === 0) {
    return { ok: false, message: 'No changes supplied' };
  }
  const { authHeader, isAuthenticated } = await getAdminAuthContext();
  if (!isAuthenticated) return { ok: false, message: 'Sign in required' };
  const result = await editAdminScheme(authHeader, schemeId, patch, note);
  if (!result.ok) return { ok: false, message: result.message };
  revalidatePath('/admin/schemes');
  revalidatePath(`/schemes/detail/${schemeId}`);
  return { ok: true, message: 'Scheme updated' };
}

export async function removeSchemeAction(
  schemeId: string,
  reason: string,
): Promise<SchemeActionResult> {
  if (!reason || reason.trim() === '') {
    return { ok: false, message: 'Removal reason is required' };
  }
  const { authHeader, isAuthenticated } = await getAdminAuthContext();
  if (!isAuthenticated) return { ok: false, message: 'Sign in required' };
  const result = await removeAdminScheme(authHeader, schemeId, reason.trim());
  if (!result.ok) return { ok: false, message: result.message };
  revalidatePath('/admin/schemes');
  revalidatePath('/admin');
  return { ok: true, message: 'Scheme removed' };
}
