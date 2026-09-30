export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
  /** Replaces the visible label as the accessible name. */
  ariaLabel?: string;
  title?: string;
}

export interface SegmentedProps<T extends string> {
  /** Names the group for assistive tech. */
  label: string;
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
  "data-testid"?: string;
}

/**
 * A square segmented control: the selected segment is a full ink inversion
 * (the R2 Settings theme recipe, ~16:1 both themes), every segment a ≥44px
 * row, and focus an inset ring so the group's border never clips it. A
 * disabled segment keeps readable ink-muted text and says why only if the
 * caller puts the reason on screen — a `title` alone never reaches touch.
 */
export default function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  className,
  "data-testid": testId,
}: SegmentedProps<T>) {
  return (
    <fieldset aria-label={label} data-testid={testId} className={["umbra-segmented", className].filter(Boolean).join(" ")}>
      {options.map((option) => (
        <button
          type="button"
          key={option.value}
          onClick={() => onChange(option.value)}
          disabled={option.disabled}
          aria-pressed={value === option.value}
          aria-label={option.ariaLabel}
          title={option.title}
          className="umbra-segmented__option"
        >
          {option.label}
        </button>
      ))}
    </fieldset>
  );
}
