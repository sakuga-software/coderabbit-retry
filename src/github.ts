import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { REQUEST_BODY, type Comment, type Review } from "./decide.js";

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

export async function fetchReviewState(pr: PullRequest) {
  const base = `repos/${pr.repo}`;
  const [head, reviews, comments] = await Promise.all([
    gh(["api", `${base}/pulls/${pr.number}`, "--jq", ".head.sha"]).then((sha) => sha.trim()),
    paginate<Review>(`${base}/pulls/${pr.number}/reviews`),
    paginate<Comment>(`${base}/issues/${pr.number}/comments`),
  ]);
  return { head, reviews, comments };
}

export async function requestReview(pr: PullRequest): Promise<string> {
  const url = await gh(["pr", "comment", String(pr.number), "--repo", pr.repo, "--body", REQUEST_BODY]);
  return url.trim();
}
