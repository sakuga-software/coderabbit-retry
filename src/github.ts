import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { commandBody, type Command } from "./actions.js";
import type { Comment, Review } from "./decide.js";

const execFileAsync = promisify(execFile);

async function gh(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("gh", args, { maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(stderr || (error as Error).message);
  }
}

export interface PullRequest {
  repo: string;
  number: number;
  title: string;
  url: string;
}

export interface SearchOptions {
  org: string;
  author: string;
  since: string;
}

export async function listPullRequests({ org, author, since }: SearchOptions): Promise<PullRequest[]> {
  const output = await gh([
    "search", "prs",
    "--owner", org,
    "--author", author,
    "--state", "open",
    "--created", `>=${since}`,
    "--limit", "200",
    "--json", "repository,number,title,url,isDraft",
  ]);
  const results = JSON.parse(output) as {
    repository: { nameWithOwner: string };
    number: number;
    title: string;
    url: string;
    isDraft: boolean;
  }[];
  return results
    .filter((result) => !result.isDraft)
    .map((result) => ({
      repo: result.repository.nameWithOwner,
      number: result.number,
      title: result.title,
      url: result.url,
    }));
}

async function paginate<T>(path: string): Promise<T[]> {
  const pages = JSON.parse(await gh(["api", "--paginate", "--slurp", path])) as T[][];
  return pages.flat();
}

export type PullRequestStatus = "open" | "draft" | "merged" | "closed";

interface PullSummary {
  head: { sha: string };
  state: "open" | "closed";
  draft: boolean;
  merged_at: string | null;
  mergeable_state?: string;
}

function statusOf(pull: PullSummary): PullRequestStatus {
  if (pull.merged_at) return "merged";
  if (pull.state === "closed") return "closed";
  return pull.draft ? "draft" : "open";
}

export async function fetchReviewState(pr: PullRequest) {
  const base = `repos/${pr.repo}`;
  const [pull, reviews, comments] = await Promise.all([
    gh(["api", `${base}/pulls/${pr.number}`, "--jq", "{head: {sha: .head.sha}, state, draft, merged_at, mergeable_state}"]).then((output) => JSON.parse(output) as PullSummary),
    paginate<Review>(`${base}/pulls/${pr.number}/reviews`),
    paginate<Comment>(`${base}/issues/${pr.number}/comments`),
  ]);
  return { head: pull.head.sha, status: statusOf(pull), mergeState: pull.mergeable_state ?? "unknown", reviews, comments };
}

export async function postCommand(pr: PullRequest, command: Command): Promise<string> {
  const url = await gh(["pr", "comment", String(pr.number), "--repo", pr.repo, "--body", commandBody(command)]);
  return url.trim();
}

export type MergeMethod = "squash" | "merge" | "rebase";

/**
 * Merges the pull request with the first method that the repository allows: squash, merge, then rebase.
 * The repository settings decide if GitHub deletes the branch.
 */
export async function mergePullRequest(pr: PullRequest): Promise<MergeMethod> {
  const allowed = JSON.parse(
    await gh(["api", `repos/${pr.repo}`, "--jq", "{squash: .allow_squash_merge, merge: .allow_merge_commit, rebase: .allow_rebase_merge}"]),
  ) as Record<MergeMethod, boolean>;
  const method = (["squash", "merge", "rebase"] as const).find((candidate) => allowed[candidate]);
  if (!method) throw new Error(`${pr.repo} allows no merge method`);
  await gh(["pr", "merge", String(pr.number), "--repo", pr.repo, `--${method}`]);
  return method;
}

export function openInBrowser(url: string): Promise<void> {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  return new Promise((resolve, reject) => {
    const child = spawn(opener, [url], { stdio: "ignore", detached: true });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
