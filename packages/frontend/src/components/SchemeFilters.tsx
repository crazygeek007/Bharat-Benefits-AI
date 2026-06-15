'use client';

/**
 * Client-side filter form for the scheme listing page.
 *
 * Renders the seven filter dimensions required by Requirement 2.2:
 *   State, Income Level, Category, Age, Gender, Occupation, Benefit Type.
 *
 * Submitting the form pushes the selected values onto the current pathname
 * as query parameters. The server component on the receiving end re-fetches
 * with the updated filters and applies AND logic on the backend
 * (Requirement 2.3).
 */

import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { INDIAN_STATES } from '@bharat-benefits/shared';
import {
  BENEFIT_TYPE_OPTIONS,
  GENDER_OPTIONS,
  OCCUPATION_OPTIONS,
  SCHEME_CATEGORIES,
} from '../lib/filters';
import type { SchemeFilters } from '../lib/api';

export interface SchemeFiltersProps {
  initialFilters?: SchemeFilters;
  /** When true, the category select is hidden (e.g. on category-specific pages). */
  hideCategory?: boolean;
}

const labelStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  fontSize: 13,
  color: '#24292f',
};

const inputStyle: React.CSSProperties = {
  padding: '6px 8px',
  border: '1px solid #d0d7de',
  borderRadius: 4,
  fontSize: 14,
  minWidth: 0,
};

export function SchemeFiltersForm({
  initialFilters = {},
  hideCategory = false,
}: SchemeFiltersProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [state, setState] = useState(initialFilters.state ?? '');
  const [category, setCategory] = useState(initialFilters.category ?? '');
  const [benefitType, setBenefitType] = useState(initialFilters.benefitType ?? '');
  const [gender, setGender] = useState(initialFilters.gender ?? '');
  const [occupation, setOccupation] = useState(initialFilters.occupation ?? '');
  const [age, setAge] = useState(
    initialFilters.age !== undefined ? String(initialFilters.age) : '',
  );
  const [incomeLevel, setIncomeLevel] = useState(
    initialFilters.incomeLevel !== undefined ? String(initialFilters.incomeLevel) : '',
  );

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const params = new URLSearchParams();
    if (state) params.set('state', state);
    if (!hideCategory && category) params.set('category', category);
    if (benefitType) params.set('benefitType', benefitType);
    if (gender) params.set('gender', gender);
    if (occupation) params.set('occupation', occupation);
    if (age && Number.isFinite(Number(age))) params.set('age', age);
    if (incomeLevel && Number.isFinite(Number(incomeLevel))) {
      params.set('incomeLevel', incomeLevel);
    }
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }

  function handleReset() {
    setState('');
    setCategory('');
    setBenefitType('');
    setGender('');
    setOccupation('');
    setAge('');
    setIncomeLevel('');
    router.push(pathname);
  }

  // Avoid an unused-variable lint warning while still keeping searchParams
  // available for future enhancements (e.g. preserving non-filter params).
  void searchParams;

  return (
    <form
      onSubmit={handleSubmit}
      aria-label="Filter schemes"
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
        gap: 12,
        padding: 16,
        background: '#f6f8fa',
        border: '1px solid #d0d7de',
        borderRadius: 8,
        marginBottom: 24,
      }}
    >
      <label style={labelStyle}>
        State
        <select
          value={state}
          onChange={(e) => setState(e.target.value)}
          style={inputStyle}
        >
          <option value="">Any</option>
          {INDIAN_STATES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>

      <label style={labelStyle}>
        Income Level (₹/year)
        <input
          type="number"
          min={0}
          step={1000}
          value={incomeLevel}
          onChange={(e) => setIncomeLevel(e.target.value)}
          placeholder="e.g. 250000"
          style={inputStyle}
        />
      </label>

      {!hideCategory && (
        <label style={labelStyle}>
          Category
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            style={inputStyle}
          >
            <option value="">Any</option>
            {SCHEME_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
      )}

      <label style={labelStyle}>
        Age
        <input
          type="number"
          min={0}
          max={150}
          value={age}
          onChange={(e) => setAge(e.target.value)}
          placeholder="e.g. 25"
          style={inputStyle}
        />
      </label>

      <label style={labelStyle}>
        Gender
        <select
          value={gender}
          onChange={(e) => setGender(e.target.value)}
          style={inputStyle}
        >
          <option value="">Any</option>
          {GENDER_OPTIONS.map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </select>
      </label>

      <label style={labelStyle}>
        Occupation
        <select
          value={occupation}
          onChange={(e) => setOccupation(e.target.value)}
          style={inputStyle}
        >
          <option value="">Any</option>
          {OCCUPATION_OPTIONS.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      </label>

      <label style={labelStyle}>
        Benefit Type
        <select
          value={benefitType}
          onChange={(e) => setBenefitType(e.target.value)}
          style={inputStyle}
        >
          <option value="">Any</option>
          {BENEFIT_TYPE_OPTIONS.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
      </label>

      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          gap: 8,
        }}
      >
        <button
          type="submit"
          style={{
            padding: '8px 16px',
            background: '#0b5394',
            color: '#fff',
            border: 'none',
            borderRadius: 4,
            cursor: 'pointer',
            flex: 1,
          }}
        >
          Apply filters
        </button>
        <button
          type="button"
          onClick={handleReset}
          style={{
            padding: '8px 12px',
            background: '#fff',
            color: '#24292f',
            border: '1px solid #d0d7de',
            borderRadius: 4,
            cursor: 'pointer',
          }}
        >
          Reset
        </button>
      </div>
    </form>
  );
}
