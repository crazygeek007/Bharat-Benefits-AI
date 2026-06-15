'use client';

/**
 * Client-side actions card for a single flagged scheme.
 *
 * Renders Approve and Reject buttons. Approve posts immediately;
 * Reject reveals a textarea so the administrator can supply the
 * required reason (Req 17.6) before submitting.
 */

import { useState, useTransition } from 'react';
import { approveFlagAction, rejectFlagAction } from './actions';

export interface FlagActionsProps {
  flagId: string;
}

export function FlagActions({ flagId }: FlagActionsProps) {
  const [isPending, startTransition] = useTransition();
  const [showRejectForm, setShowRejectForm] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [feedback, setFeedback] = useState<{ ok: boolean; message: string } | null>(
    null,
  );

  function handleApprove() {
    setFeedback(null);
    startTransition(async () => {
      const result = await approveFlagAction(flagId);
      setFeedback(result);
    });
  }

  function handleReject(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFeedback(null);
    startTransition(async () => {
      const result = await rejectFlagAction(flagId, rejectReason);
      setFeedback(result);
      if (result.ok) {
        setShowRejectForm(false);
        setRejectReason('');
      }
    });
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {!showRejectForm && (
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            onClick={handleApprove}
            disabled={isPending}
            style={{
              padding: '6px 12px',
              background: '#1a7f37',
              color: '#fff',
              border: 'none',
              borderRadius: 6,
              cursor: isPending ? 'wait' : 'pointer',
            }}
          >
            Approve
          </button>
          <button
            type="button"
            onClick={() => setShowRejectForm(true)}
            disabled={isPending}
            style={{
              padding: '6px 12px',
              background: '#fff',
              color: '#cf222e',
              border: '1px solid #cf222e',
              borderRadius: 6,
              cursor: 'pointer',
            }}
          >
            Reject
          </button>
        </div>
      )}
      {showRejectForm && (
        <form
          onSubmit={handleReject}
          style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
        >
          <label
            htmlFor={`reason-${flagId}`}
            style={{ fontSize: 13, fontWeight: 600 }}
          >
            Rejection reason (required)
          </label>
          <textarea
            id={`reason-${flagId}`}
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            rows={3}
            required
            style={{
              padding: 8,
              border: '1px solid #d0d7de',
              borderRadius: 6,
              fontFamily: 'inherit',
            }}
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="submit"
              disabled={isPending || rejectReason.trim() === ''}
              style={{
                padding: '6px 12px',
                background: '#cf222e',
                color: '#fff',
                border: 'none',
                borderRadius: 6,
                cursor: isPending ? 'wait' : 'pointer',
              }}
            >
              Confirm reject
            </button>
            <button
              type="button"
              onClick={() => {
                setShowRejectForm(false);
                setRejectReason('');
              }}
              disabled={isPending}
              style={{
                padding: '6px 12px',
                background: '#fff',
                color: '#24292f',
                border: '1px solid #d0d7de',
                borderRadius: 6,
                cursor: 'pointer',
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      {feedback && (
        <p
          role="status"
          style={{
            margin: 0,
            fontSize: 12,
            color: feedback.ok ? '#1a7f37' : '#cf222e',
          }}
        >
          {feedback.message}
        </p>
      )}
    </div>
  );
}
