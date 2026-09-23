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
coderabbit-retry --watch         # stay open and retry when the quota comes back
coderabbit-retry --dry-run       # show the decisions, but post nothing
coderabbit-retry --org my-org    # the default organization is sakuga-software
coderabbit-retry --help          # options and states
```

## Decision rules

- The delay comes from the **current version** of the CodeRabbit comment.
  Its "available in …" starts at the last edit of the comment (`updated_at`).
- Only a **bare** `@coderabbitai review` comment counts as a request.
  If the comment has more text, CodeRabbit replies as a chat and starts no review.
- If a request has no reply after 15 min, it no longer blocks a retry.
- A review or a "Review triggered" reply after a rate limit lifts that rate limit.
- If the delay is unreadable, the tool assumes 1 hour.
- The quota is shared by the whole organization. The tool posts one request at a time,
  after the reply to the previous one. A new rate limit puts the other pull requests on hold.

## Development

```sh
pnpm dev -- --dry-run   # run the sources with tsx
pnpm test               # tests of the decision logic
pnpm typecheck
```

## Demo

The GIF uses the real interface and the real decision logic with a fake GitHub
(`demo/demo.tsx`). The fake GitHub plays a timeline: a review in progress, a quota
that comes back, a retry, then the review. To see it live, run `pnpm demo`.
To record the GIF again (requires vhs, ttyd and ffmpeg):

```sh
demo/record.sh
```
