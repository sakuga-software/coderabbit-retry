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
  | { kind: "trigger"; availableAt: Date };

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

  const limit = botComments
    .filter(isRateLimit)
    .toSorted((a, b) => time(a.updated_at) - time(b.updated_at))
    .at(-1);
  if (!limit) return { kind: "idle", limitLifted: false };

  const limitTime = time(limit.updated_at);
  const liftedLater =
    botReviews.some((review) => time(review.submitted_at) > limitTime) ||
    botComments.some((comment) => isTriggerReply(comment) && time(comment.created_at) > limitTime);
  if (liftedLater) return { kind: "idle", limitLifted: true };

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
