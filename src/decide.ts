export const BOT_LOGIN = "coderabbitai[bot]";
export const REQUEST_BODY = "@coderabbitai review";

const UNREADABLE_DELAY_MS = 60 * 60_000;
const REQUEST_TIMEOUT_MS = 15 * 60_000;

export interface Comment {
  user: { login: string } | null;
  body: string;
  created_at: string;
  updated_at: string;
}

export interface Review {
  user: { login: string } | null;
  commit_id: string;
  submitted_at: string;
  state?: string;
}

export type Verdict = "approved" | "changes requested" | "commented";

export type Decision =
  | { kind: "reviewed"; verdict: Verdict }
  | { kind: "busy" }
  | { kind: "idle"; limitLifted: boolean }
  | { kind: "wait"; availableAt: Date; delayGuessed: boolean; source?: QuotaSource }
  | { kind: "pending"; requestedAt: Date }
  | { kind: "trigger"; availableAt: Date; source?: QuotaSource }
  | { kind: "skipped"; reason: string }
  | { kind: "paused" }
  | { kind: "unseen" };

/** Another pull request whose CodeRabbit comment gave the quota estimate. */
export interface QuotaSource {
  pr: string;
  at: Date;
}

export type QuotaSignal =
  | { kind: "limit"; pr: string; at: number; availableAt: number }
  | { kind: "refusal"; pr: string; at: number }
  | { kind: "free"; pr: string; at: number };

export interface PullRequestState {
  head: string;
  reviews: Review[];
  comments: Comment[];
  now: Date;
  /** The key of this pull request, to tell its own quota signals from the others. */
  pr?: string;
  /** The quota signals of every pull request of the developer, this one included. */
  quota?: QuotaSignal[];
}

const UNIT_MS: Record<string, number> = { hour: 3_600_000, minute: 60_000, second: 1_000 };

export function parseDelay(body: string): number | null {
  const sentence = /available in ([^.*<]+)/.exec(body)?.[1];
  if (!sentence) return null;
  const parts = [...sentence.matchAll(/(\d+)\s*(hour|minute|second)/g)];
  if (parts.length === 0) return null;
  return parts.reduce((total, [, amount, unit]) => total + Number(amount) * UNIT_MS[unit!]!, 0);
}

/**
 * Returns the commit that the last finished CodeRabbit review covered, from a marker in its summary.
 * CodeRabbit can review a commit and submit no GitHub review, for example after an incremental review.
 */
export function coveredCommit(summary: string): string | null {
  const marker = /final_review_risk_coverage:(\{[^}]*\})/.exec(summary)?.[1];
  if (!marker) return null;
  try {
    const coverage = JSON.parse(marker) as { coveredCommitId?: string; kind?: string };
    return coverage.kind === "reviewed" ? (coverage.coveredCommitId ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * Returns the reason of a skip notice in the summary, or null if the summary has none.
 * The notice title is the reason ("Draft PR not reviewed"), except the generic "Review skipped",
 * which gives the reason on the next line ("Bot user detected.").
 */
export function skipReason(summary: string): string | null {
  const start = summary.indexOf("skip review by coderabbit.ai");
  if (start === -1) return null;
  const notice = /##\s*([^\n]+)\n(?:>\s*\n)*>\s*([^\n]*)/.exec(summary.slice(start));
  if (!notice) return "no reason given";
  const [, title, nextLine] = notice;
  const reason = /^review skipped$/i.test(title!.trim()) ? nextLine! : title!;
  return reason.trim().replace(/\.$/, "") || "no reason given";
}

/**
 * Returns the verdict of the CodeRabbit reviews, with the rule of GitHub: the last review that
 * approves, requests changes or is dismissed counts. A comment review does not replace a verdict.
 */
export function reviewVerdict(botReviews: Review[]): Verdict {
  const last = botReviews.findLast((review) => ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state ?? ""));
  if (last?.state === "APPROVED") return "approved";
  if (last?.state === "CHANGES_REQUESTED") return "changes requested";
  return "commented";
}

const isBot = (item: { user: { login: string } | null }) => item.user?.login === BOT_LOGIN;
const isRateLimit = (comment: Comment) =>
  /rate limited by coderabbit\.ai|Review rate limited/.test(comment.body);
const isTriggerReply = (comment: Comment) =>
  !isRateLimit(comment) && /review (triggered|finished)/i.test(comment.body);
const isBareRequest = (comment: Comment) =>
  /^\s*@coderabbitai\s+(full\s+)?review\s*$/.test(comment.body);
const time = (iso: string) => Date.parse(iso);
const isSummary = (comment: Comment) => comment.body.includes("summarize by coderabbit.ai");
const REMAINING = /(\d+) remains? after this review/;
const NOT_SETTLED = /rate limited by coderabbit\.ai|review in progress by coderabbit\.ai|review paused by coderabbit\.ai/;

/**
 * Reads the quota signals in the CodeRabbit comments of one pull request:
 * - a rate limit notice with a delay gives the time when the quota comes back;
 * - a rate limit notice with no delay, such as a refused command, gives only the time of the refusal;
 * - "N remain after this review" on a settled summary tells that the quota was free.
 * The quota belongs to the developer, so the signals of all their pull requests read one clock.
 */
export function quotaSignals(pr: string, comments: Comment[], reviews: Review[]): QuotaSignal[] {
  const botComments = comments.filter(isBot);
  const signals: QuotaSignal[] = botComments.filter(isRateLimit).map((comment) => {
    const at = time(comment.updated_at);
    const delay = parseDelay(comment.body);
    return delay === null ? { kind: "refusal", pr, at } : { kind: "limit", pr, at, availableAt: at + delay };
  });
  const summary = botComments.findLast(isSummary);
  const remaining = summary && !NOT_SETTLED.test(summary.body) ? REMAINING.exec(summary.body) : null;
  if (summary && remaining) {
    // A later edit moves the updated_at of the summary but can keep this line. The review date is earlier, thus safe.
    const lastReview = reviews.filter(isBot).at(-1);
    const at = lastReview ? time(lastReview.submitted_at) : time(summary.updated_at);
    signals.push(Number(remaining[1]) > 0 ? { kind: "free", pr, at } : { kind: "refusal", pr, at });
  }
  return signals;
}

type QuotaEstimate =
  | { free: true; availableAt: number; source: QuotaSignal }
  | { free: false; availableAt: number; guessed: boolean; source?: QuotaSignal };

/**
 * Estimates when the quota comes back for a pull request that CodeRabbit refused at limitAt.
 * A free signal after the refusal means that the quota is back. Otherwise the newest notice with a delay
 * gives the time, unless a refusal came after that time: then the tool falls back to a guess.
 */
function estimateQuota(limitAt: number, signals: QuotaSignal[]): QuotaEstimate {
  const byTime = signals.toSorted((a, b) => a.at - b.at);
  const free = byTime.findLast((signal) => signal.kind === "free" && signal.at > limitAt);
  if (free) return { free: true, availableAt: free.at, source: free };
  const notice = byTime.findLast((signal) => signal.kind === "limit");
  const lastRefusal = Math.max(limitAt, ...byTime.filter((signal) => signal.kind === "refusal").map((signal) => signal.at));
  if (notice?.kind === "limit" && lastRefusal <= notice.availableAt) {
    return { free: false, availableAt: notice.availableAt, guessed: false, source: notice };
  }
  return { free: false, availableAt: lastRefusal + UNREADABLE_DELAY_MS, guessed: true };
}

export function decide({ head, reviews, comments, now, pr = "this", quota }: PullRequestState): Decision {
  const botReviews = reviews.filter(isBot);
  const botComments = comments.filter(isBot);

  const reviewed = { kind: "reviewed", verdict: reviewVerdict(botReviews) } as const;
  if (botReviews.some((review) => review.commit_id === head)) return reviewed;

  // CodeRabbit rewrites its summary comment at each state change. Only the current body is
  // valid, and its updated_at is the start of the "available in …" delay.
  const summary = botComments.findLast((comment) => comment.body.includes("summarize by coderabbit.ai"));
  if (summary?.body.includes("review in progress by coderabbit.ai")) return { kind: "busy" };

  if (summary && coveredCommit(summary.body) === head) return reviewed;

  const limited = rateLimitDecision(comments, botComments, botReviews, now, pr, quota ?? quotaSignals(pr, comments, reviews));
  if (limited) return limited;

  if (botComments.length === 0 && botReviews.length === 0) return { kind: "unseen" };
  const skipped = summary && skipReason(summary.body);
  if (skipped) return { kind: "skipped", reason: skipped };
  if (summary?.body.includes("review paused by coderabbit.ai")) return { kind: "paused" };
  return { kind: "idle", limitLifted: botComments.some(isRateLimit) };
}

function rateLimitDecision(
  comments: Comment[],
  botComments: Comment[],
  botReviews: Review[],
  now: Date,
  pr: string,
  quota: QuotaSignal[],
): Decision | null {
  const limit = botComments
    .filter(isRateLimit)
    .toSorted((a, b) => time(a.updated_at) - time(b.updated_at))
    .at(-1);
  if (!limit) return null;

  const limitTime = time(limit.updated_at);
  const liftedLater =
    botReviews.some((review) => time(review.submitted_at) > limitTime) ||
    botComments.some((comment) => isTriggerReply(comment) && time(comment.created_at) > limitTime);
  if (liftedLater) return null;

  const estimate = estimateQuota(limitTime, quota);
  const availableAt = new Date(estimate.availableAt);
  const source = estimate.source && estimate.source.pr !== pr ? { pr: estimate.source.pr, at: new Date(estimate.source.at) } : undefined;
  if (!estimate.free && now < availableAt) return { kind: "wait", availableAt, delayGuessed: estimate.guessed, ...(source && { source }) };

  const request = comments
    .filter((comment) => !isBot(comment) && isBareRequest(comment) && time(comment.created_at) > limitTime)
    .at(-1);
  if (request) {
    const requestTime = time(request.created_at);
    const unanswered = botComments.every((comment) => time(comment.updated_at) < requestTime);
    if (unanswered && now.getTime() - requestTime < REQUEST_TIMEOUT_MS) {
      return { kind: "pending", requestedAt: new Date(requestTime) };
    }
  }

  return { kind: "trigger", availableAt, ...(source && { source }) };
}
