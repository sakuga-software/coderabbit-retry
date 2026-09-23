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
}

function statusOf(pull: PullSummary): PullRequestStatus {
  if (pull.merged_at) return "merged";
  if (pull.state === "closed") return "closed";
  return pull.draft ? "draft" : "open";
}

export async function fetchReviewState(pr: PullRequest) {
  const base = `repos/${pr.repo}`;
  const [pull, reviews, comments] = await Promise.all([
    gh(["api", `${base}/pulls/${pr.number}`, "--jq", "{head: {sha: .head.sha}, state, draft, merged_at}"]).then((output) => JSON.parse(output) as PullSummary),
    paginate<Review>(`${base}/pulls/${pr.number}/reviews`),
    paginate<Comment>(`${base}/issues/${pr.number}/comments`),
  ]);
  return { head: pull.head.sha, status: statusOf(pull), reviews, comments };
}

export async function postCommand(pr: PullRequest, command: Command): Promise<string> {
  const url = await gh(["pr", "comment", String(pr.number), "--repo", pr.repo, "--body", commandBody(command)]);
  return url.trim();
}

export function openInBrowser(url: string): void {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  spawn(opener, [url], { stdio: "ignore", detached: true }).unref();
}
