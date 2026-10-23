import { useEffect, useId, useState, type KeyboardEvent } from "react";

interface NumericFieldProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  integer?: boolean;
  onCommit(value: number): void;
}

function formatNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toFixed(6)));
}

export function NumericField({ label, value, min, max, step, unit, integer = false, onCommit }: NumericFieldProps) {
  const inputId = useId();
  const errorId = `${inputId}-error`;
  const [draft, setDraft] = useState(() => formatNumber(value));
  const [error, setError] = useState("");

  useEffect(() => {
    setDraft(formatNumber(value));
    setError("");
  }, [value]);

  const commit = () => {
    const next = Number(draft);
    if (draft.trim() === "" || !Number.isFinite(next)) {
      setError("Enter a finite number.");
      return;
    }
    if (integer && !Number.isInteger(next)) {
      setError("Enter a whole number.");
      return;
    }
    if (next < min || next > max) {
      setError(`Enter a value from ${formatNumber(min)} to ${formatNumber(max)}${unit ? ` ${unit}` : ""}.`);
      return;
    }
    setError("");
    setDraft(formatNumber(next));
    if (next !== value) onCommit(next);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      event.currentTarget.blur();
    } else if (event.key === "Escape") {
      event.preventDefault();
      setDraft(formatNumber(value));
      setError("");
      event.currentTarget.blur();
    }
  };

  return (
    <div className={`numeric-field${error ? " numeric-field--invalid" : ""}`}>
      <label htmlFor={inputId}>{label}</label>
      <div className="numeric-field__control">
        <input
          id={inputId}
          type="number"
          inputMode={integer ? "numeric" : "decimal"}
          value={draft}
          min={min}
          max={max}
          step={step}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? errorId : undefined}
          onChange={(event) => {
            setDraft(event.target.value);
            if (error) setError("");
          }}
          onBlur={commit}
          onKeyDown={onKeyDown}
        />
        {unit && <span aria-hidden="true">{unit}</span>}
      </div>
      {error && <p id={errorId} className="field-error">{error}</p>}
    </div>
  );
}
