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
}

export type Decision =
  | { kind: "reviewed" }
  | { kind: "busy" }
  | { kind: "idle"; limitLifted: boolean }
  | { kind: "wait"; availableAt: Date; delayGuessed: boolean }
  | { kind: "pending"; requestedAt: Date }
  | { kind: "trigger"; availableAt: Date }
  | { kind: "skipped"; reason: string }
  | { kind: "paused" }
  | { kind: "unseen" };

export interface PullRequestState {
  head: string;
  reviews: Review[];
  comments: Comment[];
  now: Date;
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

const isBot = (item: { user: { login: string } | null }) => item.user?.login === BOT_LOGIN;
const isRateLimit = (comment: Comment) =>
  /rate limited by coderabbit\.ai|Review rate limited/.test(comment.body);
const isTriggerReply = (comment: Comment) =>
  !isRateLimit(comment) && /review (triggered|finished)/i.test(comment.body);
const isBareRequest = (comment: Comment) =>
  /^\s*@coderabbitai\s+(full\s+)?review\s*$/.test(comment.body);
const time = (iso: string) => Date.parse(iso);

export function decide({ head, reviews, comments, now }: PullRequestState): Decision {
  const botReviews = reviews.filter(isBot);
  const botComments = comments.filter(isBot);

  if (botReviews.some((review) => review.commit_id === head)) return { kind: "reviewed" };

  // CodeRabbit rewrites its summary comment at each state change. Only the current body is
  // valid, and its updated_at is the start of the "available in …" delay.
  const summary = botComments.findLast((comment) => comment.body.includes("summarize by coderabbit.ai"));
  if (summary?.body.includes("review in progress by coderabbit.ai")) return { kind: "busy" };

  if (summary && coveredCommit(summary.body) === head) return { kind: "reviewed" };

  const limited = rateLimitDecision(comments, botComments, botReviews, now);
  if (limited) return limited;

  if (botComments.length === 0 && botReviews.length === 0) return { kind: "unseen" };
  const skipped = summary && skipReason(summary.body);
  if (skipped) return { kind: "skipped", reason: skipped };
  if (summary?.body.includes("review paused by coderabbit.ai")) return { kind: "paused" };
  return { kind: "idle", limitLifted: botComments.some(isRateLimit) };
}

function rateLimitDecision(comments: Comment[], botComments: Comment[], botReviews: Review[], now: Date): Decision | null {
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

  const delay = parseDelay(limit.body);
  const availableAt = new Date(limitTime + (delay ?? UNREADABLE_DELAY_MS));
  if (now < availableAt) return { kind: "wait", availableAt, delayGuessed: delay === null };

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

  return { kind: "trigger", availableAt };
}
