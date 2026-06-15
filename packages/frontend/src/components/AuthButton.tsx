'use client';

/**
 * Auth button — shows "Sign in" when logged out, user menu when logged in.
 * Drops into the SiteHeader controls area.
 */

import { useSession, signOut } from 'next-auth/react';
import { useState, useRef, useEffect } from 'react';

export function AuthButton() {
  const { data: session, status } = useSession();
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [isOpen]);

  if (status === 'loading') {
    return (
      <div
        aria-hidden="true"
        style={{
          width: 80,
          height: 36,
          borderRadius: 10,
          background: '#f4f4f5',
        }}
      />
    );
  }

  if (status === 'unauthenticated') {
    return (
      <a
        href="/login"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          padding: '8px 16px',
          background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
          color: '#fff',
          borderRadius: 10,
          fontSize: 14,
          fontWeight: 600,
          textDecoration: 'none',
          boxShadow: '0 2px 8px rgba(99, 102, 241, 0.3)',
          transition: 'all 0.2s',
        }}
      >
        Sign in
      </a>
    );
  }

  // Authenticated — show user pill with dropdown
  const email = (session?.user?.email as string) ?? 'User';
  const initial = email.charAt(0).toUpperCase();

  return (
    <div ref={menuRef} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setIsOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 10px 6px 6px',
          background: '#fff',
          border: '1px solid #e4e4e7',
          borderRadius: 10,
          cursor: 'pointer',
          fontSize: 14,
          color: '#09090b',
          fontWeight: 500,
          transition: 'all 0.2s',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.borderColor = '#d4d4d8';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.borderColor = '#e4e4e7';
        }}
      >
        <span
          aria-hidden="true"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 26,
            height: 26,
            background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
            color: '#fff',
            borderRadius: 6,
            fontSize: 12,
            fontWeight: 700,
          }}
        >
          {initial}
        </span>
        <span style={{ fontSize: 11, color: '#a1a1aa' }} aria-hidden="true">
          ▾
        </span>
      </button>

      {isOpen && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            right: 0,
            minWidth: 220,
            maxWidth: 'min(280px, calc(100vw - 32px))',
            background: '#fff',
            border: '1px solid #e4e4e7',
            borderRadius: 12,
            boxShadow: '0 10px 25px -5px rgba(0,0,0,0.15), 0 4px 6px -2px rgba(0,0,0,0.05)',
            padding: 6,
            zIndex: 200,
          }}
        >
          <div
            style={{
              padding: '8px 12px',
              fontSize: 13,
              color: '#71717a',
              borderBottom: '1px solid #f4f4f5',
              marginBottom: 4,
              wordBreak: 'break-all',
            }}
          >
            {email}
          </div>
          <MenuLink href="/profile" onClick={() => setIsOpen(false)}>
            Profile
          </MenuLink>
          <MenuLink href="/dashboard" onClick={() => setIsOpen(false)}>
            Dashboard
          </MenuLink>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setIsOpen(false);
              signOut({ callbackUrl: '/' });
            }}
            style={{
              display: 'block',
              width: '100%',
              textAlign: 'left',
              padding: '9px 12px',
              background: 'transparent',
              border: 'none',
              borderRadius: 8,
              fontSize: 14,
              color: '#dc2626',
              cursor: 'pointer',
              fontFamily: 'inherit',
              fontWeight: 500,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = '#fef2f2';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
            }}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

function MenuLink({
  href,
  onClick,
  children,
}: {
  href: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <a
      role="menuitem"
      href={href}
      onClick={onClick}
      style={{
        display: 'block',
        padding: '9px 12px',
        borderRadius: 8,
        fontSize: 14,
        color: '#09090b',
        textDecoration: 'none',
        fontWeight: 500,
        transition: 'background 0.15s',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = '#fafafa';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent';
      }}
    >
      {children}
    </a>
  );
}
