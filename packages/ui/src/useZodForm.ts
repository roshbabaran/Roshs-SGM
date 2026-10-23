import { useCallback, useEffect, useState } from 'react';
import type { z } from 'zod';

type FieldErrors<V> = Partial<Record<keyof V & string, string>>;

function check<S extends z.ZodType>(schema: S, values: z.input<S>) {
  const result = schema.safeParse(values);
  // `ok` rather than a null check: some schemas turn valid input into null, such as a blank down payment.
  if (result.success) return { ok: true as const, data: result.data as z.output<S>, errors: {} as FieldErrors<z.input<S>> };
  const errors: FieldErrors<z.input<S>> = {};
  for (const issue of result.error.issues) {
    const field = issue.path[0];
    if (typeof field === 'string' && !(field in errors)) errors[field as keyof z.input<S> & string] = issue.message;
  }
  return { ok: false as const, data: null, errors };
}

/**
 * Form state checked by a zod schema from @sgm/core, so the phone and the PC
 * apply the same rules. Errors appear after the first submit, then update as
 * the person types.
 */
export function useZodForm<S extends z.ZodType>(schema: S, initial: z.input<S>) {
  const [values, setValues] = useState<z.input<S>>(initial);
  const [errors, setErrors] = useState<FieldErrors<z.input<S>>>({});
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (submitted) setErrors(check(schema, values).errors);
  }, [schema, values, submitted]);

  const set = useCallback(<K extends keyof z.input<S>>(field: K, value: z.input<S>[K]) => {
    setValues((current) => ({ ...(current as object), [field]: value }) as z.input<S>);
  }, []);

  const handleSubmit = (onValid: (data: z.output<S>) => void | Promise<void>) => async () => {
    setSubmitted(true);
    const result = check(schema, values);
    setErrors(result.errors);
    if (result.ok) await onValid(result.data);
  };

  const reset = useCallback((next: z.input<S>) => {
    setValues(next);
    setErrors({});
    setSubmitted(false);
  }, []);

  return { values, errors, set, handleSubmit, reset };
}
