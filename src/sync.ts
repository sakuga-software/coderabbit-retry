import type { PullRequestStatus } from "./github.js";

export type LeftStatus = Exclude<PullRequestStatus, "open">;

export interface Tracked {
  key: string;
  left?: LeftStatus;
}

export interface SyncPlan {
  added: string[];
  recheck: string[];
}

/**
 * Compares the tracked pull requests with a new search result.
 * A tracked pull request needs a new check if it left the result while it was open,
 * or if it came back to the result after it left.
 */
export function planSync(tracked: Tracked[], listed: string[]): SyncPlan {
  const known = new Set(tracked.map((item) => item.key));
  const current = new Set(listed);
  return {
    added: listed.filter((key) => !known.has(key)),
    recheck: tracked
      .filter((item) => (current.has(item.key) ? item.left !== undefined : item.left === undefined))
      .map((item) => item.key),
  };
}
