export type Command = "review" | "full review" | "approve" | "resolve";

export interface Action {
  key: string;
  label: string;
  command?: Command;
}

export const ACTIONS: readonly Action[] = [
  { key: "o", label: "open" },
  { key: "r", label: "retry", command: "review" },
  { key: "f", label: "full review", command: "full review" },
  { key: "a", label: "approve", command: "approve" },
  { key: "s", label: "resolve", command: "resolve" },
];

export const commandBody = (command: Command) => `@coderabbitai ${command}`;

export const actionForKey = (input: string) => ACTIONS.find((action) => action.key === input);

export interface Target {
  left: boolean;
  dryRun: boolean;
}

/** Returns why the action is not available on the target, or null if it is available. */
export function refusal(action: Action, target: Target): string | null {
  if (!action.command) return null;
  if (target.left) return "this pull request is no longer open";
  if (target.dryRun) return "dry run: the tool posts nothing";
  return null;
}

/** Moves a selection by key, so a row that the list refresh adds or moves keeps its place. */
export function moveSelection(keys: string[], selected: string | undefined, step: number): string | undefined {
  if (keys.length === 0) return undefined;
  const index = selected === undefined ? -1 : keys.indexOf(selected);
  if (index === -1) return keys[0];
  return keys[Math.min(keys.length - 1, Math.max(0, index + step))];
}

/**
 * Keeps the selection on a visible row. If the selected row is hidden, the selection goes to
 * the next visible row in the full list, or to the previous one at the end of the list.
 */
export function reselect(allKeys: string[], visibleKeys: string[], selected: string | undefined): string | undefined {
  if (visibleKeys.length === 0) return undefined;
  if (selected !== undefined && visibleKeys.includes(selected)) return selected;
  const visible = new Set(visibleKeys);
  const index = selected === undefined ? -1 : allKeys.indexOf(selected);
  if (index === -1) return visibleKeys[0];
  return allKeys.slice(index + 1).find((key) => visible.has(key)) ?? allKeys.slice(0, index).findLast((key) => visible.has(key));
}
