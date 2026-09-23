# coderabbit-retry

Posts `@coderabbitai review` on your open pull requests after their CodeRabbit quota comes back.

![coderabbit-retry --watch on simulated data](docs/demo.gif)

When the review quota of an organization is used up, CodeRabbit posts "Review limit reached"
with a delay instead of a review. This tool reads each pull request, calculates when the
quota comes back, and posts the command after that time.

## Installation

```sh
git clone https://github.com/sakuga-software/coderabbit-retry.git
cd coderabbit-retry
pnpm install          # the prepare script builds dist/
ln -sf "$PWD/dist/cli.js" ~/.local/bin/coderabbit-retry
```

Requires Node 22 or later and an authenticated `gh` (`gh auth status`).

## Usage

```sh
coderabbit-retry                 # retry what can be retried, then quit
coderabbit-retry --watch         # stay open until Ctrl+C, and retry when the quota comes back
coderabbit-retry --dry-run       # show the decisions, but post nothing
coderabbit-retry --org my-org    # the default organization is sakuga-software
coderabbit-retry --help          # options and states
```

## Decision rules

- A commit counts as reviewed if CodeRabbit submitted a GitHub review on it, or if its summary
  says that a finished review covered it (`final_review_risk_coverage`). An incremental review
  with no new finding often submits no GitHub review.
- A summary that says "Review skipped" (a bot author, a draft) gives the state `skipped`
  with the reason. "Reviews paused" gives `paused`. The tool retries neither by itself:
  CodeRabbit chose not to review. Press `r` to ask once.
- A pull request with no CodeRabbit comment and no review gives `no review yet`.
- The delay comes from the **current version** of the CodeRabbit comment.
  Its "available in …" starts at the last edit of the comment (`updated_at`).
- Only a **bare** `@coderabbitai review` comment counts as a request.
  If the comment has more text, CodeRabbit replies as a chat and starts no review.
- If a request has no reply after 15 min, it no longer blocks a retry.
- A review or a "Review triggered" reply after a rate limit lifts that rate limit.
- If the delay is unreadable, the tool assumes 1 hour.
- The quota is shared by the whole organization. The tool posts one request at a time,
  after the reply to the previous one. A new rate limit puts the other pull requests on hold.
- With `--watch`, the tool searches the pull requests again once a minute. It adds the new
  ones, and shows the ones that are merged, closed or back to draft. It never posts on those.
  A draft that is ready for review again comes back into the watch.
- With `--watch`, the settled rows (up to date, nothing to do, skipped, paused, no review yet)
  are checked again at each list refresh. A first review then shows up when it starts and when
  it ends, and a push that CodeRabbit has not reviewed yet shows up too.

## Keys and mouse

With `--watch` in a terminal, the tool opens in full screen and takes keys and mouse clicks.
Piped or scheduled runs stay as they are.

| Key | Action |
| --- | --- |
| `↑` `↓` or `k` `j` | select a pull request (the mouse wheel does it too) |
| `o` or `Enter` | open the pull request in the browser |
| `r` | post `@coderabbitai review` |
| `f` | post `@coderabbitai full review` |
| `a` | post `@coderabbitai approve`: resolve the CodeRabbit threads, then approve |
| `s` | post `@coderabbitai resolve`: resolve the CodeRabbit threads |
| `h` | hide or show the merged, closed and draft pull requests |
| `q` | quit |

Each post asks for a confirmation: `y` or `Enter` posts, `n` or `Esc` cancels. A post goes
through the same queue as the automatic retries: one post at a time, after the reply to the
previous one. A click selects a row or presses a button of the bar. The mouse mode takes over
text selection: hold Shift or Option, depending on the terminal, to select text. A merged or
closed pull request accepts only `o`, and `--dry-run` disables every post.

## Development

```sh
pnpm dev -- --dry-run   # run the sources with tsx
pnpm test               # tests of the decision logic
pnpm typecheck
```

## Demo

The GIF uses the real interface and the real decision logic with a fake GitHub
(`demo/demo.tsx`). The fake GitHub plays a timeline: a review in progress, a quota
that comes back, a retry, a merged pull request, a new pull request, then the reviews. At the end, it
hides the merged pull request with `h`, selects a pull request with the arrow keys, and posts
`@coderabbitai approve` with `a`, then `Enter`.
To see it live, run `pnpm demo`.
To record the GIF again (requires vhs, ttyd and ffmpeg):

```sh
demo/record.sh
```
