/**
 * Accessible form-field wrapper (Requirements 20.3, 20.7).
 *
 * Composes a `<label>`, control, optional helper text, and optional
 * error message into a single tree where:
 *
 *   - The label is programmatically associated with the control via the
 *     shared `inputId` (so screen readers announce the label when focus
 *     lands on the input — Req 20.3).
 *   - The helper and error nodes are linked to the control via
 *     `aria-describedby` (Req 20.7).
 *   - The control is marked `aria-invalid="true"` when an error is
 *     present, so assistive technology can audibly distinguish error
 *     fields from regular ones.
 *   - The error region is rendered inside an `aria-live="polite"`
 *     container so newly-set errors are announced (Req 20.6).
 *
 * The component is a *render prop* that hands the calling component the
 * three id strings plus the `aria-*` attributes it should spread onto
 * its own input element. This keeps the wrapper agnostic to the
 * underlying control type — it works for `<input>`, `<select>`,
 * `<textarea>`, and any custom widget.
 */

import { useId } from 'react';
import {
  describedBy,
  type FieldIds,
  fieldIds,
  slugifyForId,
} from '../lib/a11y';

export interface FormFieldRenderProps {
  /** id to apply to the underlying input element. */
  inputId: string;
  /** Spread these attributes onto the input element. */
  inputAttributes: {
    id: string;
    'aria-invalid'?: 'true';
    'aria-describedby'?: string;
    'aria-required'?: 'true';
  };
}

export interface FormFieldProps {
  /** Visible label text. */
  label: string;
  /** Optional helper text rendered below the input. */
  helper?: string;
  /** Optional error message; when set the field is marked invalid. */
  error?: string;
  /** Marks the field as required (visual asterisk + aria-required). */
  required?: boolean;
  /**
   * Stable id base. When omitted React's `useId` is used so each render
   * gets a deterministic id. Pass an explicit base when you need to
   * reference the input from outside the component.
   */
  idBase?: string;
  /** Optional CSS class for the outer container. */
  className?: string;
  /** Optional inline styles for the outer container. */
  style?: React.CSSProperties;
  /** Render the control. The function receives the ids/aria attributes. */
  children: (props: FormFieldRenderProps) => React.ReactNode;
}

const containerStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

const labelStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: '#24292f',
};

const helperStyle: React.CSSProperties = {
  fontSize: 12,
  color: '#57606a',
};

const errorStyle: React.CSSProperties = {
  fontSize: 13,
  color: '#86181d',
  fontWeight: 500,
};

const requiredAsteriskStyle: React.CSSProperties = {
  color: '#b1232b',
  marginLeft: 4,
};

export function FormField({
  label,
  helper,
  error,
  required = false,
  idBase,
  className,
  style,
  children,
}: FormFieldProps) {
  // useId guarantees a stable id even across SSR. We slugify any
  // explicit base so callers can pass natural language without
  // worrying about HTML id rules.
  const reactId = useId();
  const base = idBase ? slugifyForId(idBase) : `bb-field-${reactId.replace(/:/g, '')}`;
  const ids: FieldIds = fieldIds(base);

  const hasError = typeof error === 'string' && error.length > 0;
  const hasHelper = typeof helper === 'string' && helper.length > 0;

  const describedByValue = describedBy({
    hasHelper,
    hasError,
    helperId: ids.helperId,
    errorId: ids.errorId,
  });

  const inputAttributes: FormFieldRenderProps['inputAttributes'] = {
    id: ids.inputId,
  };
  if (hasError) inputAttributes['aria-invalid'] = 'true';
  if (describedByValue) inputAttributes['aria-describedby'] = describedByValue;
  if (required) inputAttributes['aria-required'] = 'true';

  return (
    <div className={className} style={{ ...containerStyle, ...style }}>
      <label id={ids.labelId} htmlFor={ids.inputId} style={labelStyle}>
        {label}
        {required && (
          <span aria-hidden="true" style={requiredAsteriskStyle}>
            *
          </span>
        )}
        {required && <span className="sr-only"> (required)</span>}
      </label>

      {children({ inputId: ids.inputId, inputAttributes })}

      {hasHelper && (
        <p id={ids.helperId} style={helperStyle}>
          {helper}
        </p>
      )}

      {/*
       * The error region is always rendered with aria-live so that
       * server-side validation surfacing a new error after submission
       * is announced. When there is no error the node is empty so AT
       * stays quiet.
       */}
      <div
        id={ids.errorId}
        role={hasError ? 'alert' : undefined}
        aria-live="polite"
        style={hasError ? errorStyle : { display: 'none' }}
      >
        {hasError ? error : null}
      </div>
    </div>
  );
}
