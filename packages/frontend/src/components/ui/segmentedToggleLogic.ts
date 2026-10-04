interface ToggleOption {
  value: string;
  disabled?: boolean;
}

/**
 * The option an arrow key moves to: the next (`dir` 1) or previous (-1) enabled option, wrapping at the ends and
 * skipping disabled ones. Null when nothing should change: the whole toggle is disabled, the current value is not an
 * enabled option, or it is the only enabled option.
 */
export function nextEnabledOption<O extends ToggleOption>(
  options: readonly O[],
  value: O['value'],
  dir: 1 | -1,
  allDisabled = false,
): O | null {
  if (allDisabled) return null;
  const enabled = options.filter((o) => !o.disabled);
  const at = enabled.findIndex((o) => o.value === value);
  if (at < 0 || enabled.length < 2) return null;
  return enabled[(at + dir + enabled.length) % enabled.length];
}
