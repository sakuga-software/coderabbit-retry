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
