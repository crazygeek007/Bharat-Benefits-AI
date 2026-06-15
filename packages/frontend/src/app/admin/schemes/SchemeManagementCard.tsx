'use client';

/**
 * Per-scheme management card used on `/admin/schemes`.
 *
 * Provides three actions wired to server actions defined in
 * `actions.ts`:
 *   - Verify: lifts trustScore and flips `verified` to true (Req 17.2).
 *   - Edit: opens a small form covering the editable fields and posts
 *     a patch with optional note.
 *   - Remove: requires a reason and deletes the scheme (Req 17.2).
 *
 * The component intentionally renders all three forms inline instead
 * of opening a modal — admins toggle between them via the Action
 * select. Keeps the keyboard order predictable for a11y.
 */

import { useState, useTransition } from 'react';
import {
  editSchemeAction,
  removeSchemeAction,
  verifySchemeAction,
} from './actions';

export interface SchemeManagementCardScheme {
  id: string;
  name: string;
  description: string;
  ministry: string;
  state: string | null;
  category: string;
  sourceUrl: string;
  benefitAmount: number | null;
  applicationMode: string | null;
  applicationUrl: string | null;
  trustScore: number;
  verified: boolean;
  lastVerifiedAt: string | null;
}

export interface SchemeManagementCardProps {
  scheme: SchemeManagementCardScheme;
}

type Mode = 'idle' | 'edit' | 'remove';

export function SchemeManagementCard({ scheme }: SchemeManagementCardProps) {
  const [mode, setMode] = useState<Mode>('idle');
  const [feedback, setFeedback] = useState<{ ok: boolean; message: string } | null>(
    null,
  );
  const [isPending, startTransition] = useTransition();

  const [editName, setEditName] = useState(scheme.name);
  const [editDescription, setEditDescription] = useState(scheme.description);
  const [editBenefit, setEditBenefit] = useState(
    scheme.benefitAmount === null ? '' : String(scheme.benefitAmount),
  );
  const [editNote, setEditNote] = useState('');
  const [removeReason, setRemoveReason] = useState('');

  function handleVerify() {
    setFeedback(null);
    startTransition(async () => {
      const result = await verifySchemeAction(scheme.id);
      setFeedback(result);
    });
  }

  function buildPatch(): Record<string, unknown> {
    const patch: Record<string, unknown> = {};
    if (editName.trim() && editName.trim() !== scheme.name) {
      patch.name = editName.trim();
    }
    if (editDescription.trim() && editDescription.trim() !== scheme.description) {
      patch.description = editDescription.trim();
    }
    if (editBenefit.trim() === '') {
      if (scheme.benefitAmount !== null) patch.benefitAmount = null;
    } else {
      const value = Number(editBenefit);
      if (Number.isFinite(value) && value !== scheme.benefitAmount) {
        patch.benefitAmount = value;
      }
    }
    return patch;
  }

  function handleEditSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFeedback(null);
    const patch = buildPatch();
    if (Object.keys(patch).length === 0) {
      setFeedback({ ok: false, message: 'No changes to save' });
      return;
    }
    startTransition(async () => {
      const result = await editSchemeAction(
        scheme.id,
        patch,
        editNote.trim() || undefined,
      );
      setFeedback(result);
      if (result.ok) {
        setMode('idle');
        setEditNote('');
      }
    });
  }

  function handleRemoveSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFeedback(null);
    startTransition(async () => {
      const result = await removeSchemeAction(scheme.id, removeReason);
      setFeedback(result);
      if (result.ok) {
        setMode('idle');
        setRemoveReason('');
      }
    });
  }

  return (
    <article
      style={{
        background: '#fff',
        border: '1px solid #d0d7de',
        borderRadius: 8,
        padding: 16,
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
        }}
      >
        <div>
          <h3 style={{ margin: 0, fontSize: 16 }}>{scheme.name}</h3>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#57606a' }}>
            {scheme.ministry}
            {scheme.state ? ` · ${scheme.state}` : ''} · Trust score{' '}
            {scheme.trustScore} ·{' '}
            {scheme.verified ? 'Verified' : 'Unverified'}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            onClick={handleVerify}
            disabled={isPending}
            style={buttonStyle('primary')}
          >
            Verify
          </button>
          <button
            type="button"
            onClick={() => setMode(mode === 'edit' ? 'idle' : 'edit')}
            disabled={isPending}
            style={buttonStyle('secondary')}
          >
            {mode === 'edit' ? 'Cancel edit' : 'Edit'}
          </button>
          <button
            type="button"
            onClick={() => setMode(mode === 'remove' ? 'idle' : 'remove')}
            disabled={isPending}
            style={buttonStyle('danger')}
          >
            {mode === 'remove' ? 'Cancel remove' : 'Remove'}
          </button>
        </div>
      </header>

      {mode === 'edit' && (
        <form
          onSubmit={handleEditSubmit}
          style={{ marginTop: 12, display: 'grid', gap: 8 }}
        >
          <label style={fieldStyle}>
            <span style={labelStyle}>Name</span>
            <input
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              style={inputStyle}
            />
          </label>
          <label style={fieldStyle}>
            <span style={labelStyle}>Description</span>
            <textarea
              value={editDescription}
              onChange={(e) => setEditDescription(e.target.value)}
              rows={3}
              style={inputStyle}
            />
          </label>
          <label style={fieldStyle}>
            <span style={labelStyle}>Benefit amount (INR, blank for none)</span>
            <input
              value={editBenefit}
              onChange={(e) => setEditBenefit(e.target.value)}
              inputMode="decimal"
              style={inputStyle}
            />
          </label>
          <label style={fieldStyle}>
            <span style={labelStyle}>Audit note (optional)</span>
            <input
              value={editNote}
              onChange={(e) => setEditNote(e.target.value)}
              style={inputStyle}
            />
          </label>
          <div>
            <button
              type="submit"
              disabled={isPending}
              style={buttonStyle('primary')}
            >
              Save changes
            </button>
          </div>
        </form>
      )}

      {mode === 'remove' && (
        <form
          onSubmit={handleRemoveSubmit}
          style={{ marginTop: 12, display: 'grid', gap: 8 }}
        >
          <label style={fieldStyle}>
            <span style={labelStyle}>Removal reason (required)</span>
            <textarea
              value={removeReason}
              onChange={(e) => setRemoveReason(e.target.value)}
              rows={2}
              required
              style={inputStyle}
            />
          </label>
          <div>
            <button
              type="submit"
              disabled={isPending || removeReason.trim() === ''}
              style={buttonStyle('danger')}
            >
              Confirm remove
            </button>
          </div>
        </form>
      )}

      {feedback && (
        <p
          role="status"
          style={{
            margin: '12px 0 0',
            fontSize: 13,
            color: feedback.ok ? '#1a7f37' : '#cf222e',
          }}
        >
          {feedback.message}
        </p>
      )}
    </article>
  );
}

const fieldStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

const labelStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: '#57606a',
};

const inputStyle: React.CSSProperties = {
  padding: 8,
  border: '1px solid #d0d7de',
  borderRadius: 6,
  fontFamily: 'inherit',
  fontSize: 14,
};

function buttonStyle(variant: 'primary' | 'secondary' | 'danger'): React.CSSProperties {
  const palette: Record<typeof variant, { bg: string; fg: string; border: string }> = {
    primary: { bg: '#0b5394', fg: '#fff', border: '#0b5394' },
    secondary: { bg: '#fff', fg: '#24292f', border: '#d0d7de' },
    danger: { bg: '#fff', fg: '#cf222e', border: '#cf222e' },
  };
  const { bg, fg, border } = palette[variant];
  return {
    padding: '6px 12px',
    background: bg,
    color: fg,
    border: `1px solid ${border}`,
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: 13,
  };
}
