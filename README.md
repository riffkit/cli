# Riffkit CLI

Riffkit from the terminal. Pick a winning short video (a template from the library or a TikTok link), and Riffkit remakes it into your own: your character, your product, your language. The CLI is for people who like a shell and for AI agents that run commands.

```sh
npm i -g @riffkit/cli
riffkit login
riffkit help
```

Needs Node.js 20 or newer. No dependencies, no install scripts.

## Sign in

```sh
riffkit login
```

prints a link and a short code. Open the link, check that the page shows the same code, and click Approve. The terminal signs in by itself: there is no password and nothing to paste. `riffkit logout` signs this terminal out.

Run by an AI agent (`riffkit login --agent`, or with no terminal on stderr), `riffkit login` prints the link and the code on stderr and waits up to 90 seconds, which fits in an agent's command time limit. If the user has not approved by then, it exits with code 12 and says for about how many more minutes the link works: the agent gives the user the link, and once they have approved, runs `riffkit login --agent` again. That run waits for the same link instead of starting a new sign-in, so the link the user has stays the one that counts; two runs at once wait for the same link too. The sign-in waiting for approval is kept in `~/.riffkit/login-pending` (0600) until it is approved or has ended; when the link is no longer valid, the next `riffkit login` starts a new one and prints the new link. An agent passes `--agent` because its shell may give the command a terminal, and then the CLI would wait for a person.

## Make a video

Every video starts with a price. Quote first, tell whoever is paying what it costs, and only then run the command that spends credits:

```sh
riffkit list_templates --sort used_desc --limit 5
riffkit quote_remake --formula-id <template_id> --mode adapt
#   credits in the answer are internal units: divide by 100 for the credits you see
riffkit remake_video --formula-id <template_id> --mode adapt --yes
#   answers with a batch_id
riffkit wait <batch_id>
#   when it is done, each task's result.asset_id is a finished video
riffkit download <asset_id>
```

A command that spends credits asks `Run it? [y/N]` when you run it yourself. When there is no terminal to ask in (an agent, a script) it refuses with exit code 3 unless `--yes` is given. An agent should pass `--yes` only after it has shown the user the plan and the price and the user has said yes.

`riffkit get_video_link <asset_id>` gives a link that plays the video in a browser without signing in, for 6 hours.

## Commands

The commands come from Riffkit itself: the CLI reads the list at `https://riffkit.ai/cli.json`, so a new capability on Riffkit is a new command here without updating the package. `riffkit help` lists them, grouped by what they do (read, write, spend), each with the API route it calls: a command takes that route's parameters, so a route named in the Riffkit agent skill finds its command there. `riffkit help <command>` shows a command's arguments.

- `riffkit <command> [<path arguments>] [--option value ...]`. Names work in snake_case or kebab-case: `remake_video --formula-id x` is `remake-video --formula_id x`.
- An option the command does not take is an error (a typo never runs with the defaults).
- A list option is repeated: `--asset-id a --asset-id b`. An object, or a list of objects, is JSON text: `--entities @subtitles.json`.
- An option's value starting with `@` is read from that file (UTF-8). Write `@@` for a value that starts with a literal `@` (a handle, a caption someone wrote). A path argument such as an id is never read from a file.
- A file argument takes a local path: `riffkit add_product_image <product_id> --file ./bottle.png --name bottle`.
- `--yes` runs a command that spends credits without asking.

Written into the CLI itself:

| Command | What it does |
|---|---|
| `login [--agent]` | Sign in by approving this terminal in the browser. `--agent`: run by an AI agent, wait 90 seconds at most, then exit 12 |
| `logout` | Sign out and remove the saved session |
| `wait <batch_id> [--timeout seconds]` | Check the batch every 30 seconds until nothing in it is queued or running (gives up after 540 seconds by default). Exits 0 only when every task made its video |
| `download <asset_id> [-o path]` | Save a finished video over https. Never replaces an existing file; a download cut off midway leaves only a `.part` file |
| `help [command]` | The command list, or one command's arguments |

## Output

stdout is always JSON: the answer Riffkit gave, indented at a terminal and on one line otherwise. When Riffkit refuses, the JSON has the HTTP `status` added and stderr gets one readable line. Answers come in English, as they do to curl, so the agent skill's error table matches them. Response headers are not printed (for a count of tasks, use `riffkit count_tasks`).

## Exit codes

| Code | Meaning | What to do |
|---|---|---|
| 0 | Done | |
| 1 | Refused by Riffkit (any 4xx but 401) | Read the reason on stderr and in `detail` |
| 2 | Usage error, nothing sent | Fix the command line (`riffkit help <command>`) |
| 3 | A spend was not confirmed, nothing sent | Quote, get the user's go-ahead, run again with `--yes` |
| 4 | Not signed in (401) | `riffkit login` |
| 5 | No answer to a read (network, 5xx) | Safe to run again |
| 6 | No answer to a write or a spend: it may have been accepted | Check `riffkit list_tasks` or `riffkit get_batch <batch_id>` before running it again |
| 10 | `wait` reached its timeout: the batch is still running | Run `riffkit wait <batch_id>` again |
| 11 | `wait`: the batch finished, but a task made no video (it failed, was stopped, or its analysis submitted no video: `result.auto_generate_error`) | Read each task's `error` and `result` in the JSON |
| 12 | `login --agent` (or `login` with no terminal): the user has not approved the link yet | Give the user the link from stderr; after they approve, run `riffkit login --agent` again |

Nothing is ever retried by the CLI on its own.

## Where the session is kept

`~/.riffkit/session` holds the session (directory 0700, file 0600 on macOS and Linux). It is the same file the Riffkit agent skill uses, so signing in once covers both. It is a full sign-in to your account: keep it private. The CLI never prints it, sends it only to Riffkit, and sends it as the `vee_session` cookie only. A video link from `download` is fetched without it.

## Environment

| Variable | Use |
|---|---|
| `RIFFKIT_TOKEN` | A riffkit.ai session to use instead of `~/.riffkit/session` (for CI and containers). It goes to riffkit.ai only: with `RIFFKIT_BASE_URL` set to another server, that server's own session file is used |
| `RIFFKIT_BASE_URL` | Another Riffkit server, such as a local one (`http://localhost:8000`). Plain http is accepted only for localhost. Each server gets its own session file, `~/.riffkit/session-<host>-<port>`, and its own `~/.riffkit/login-pending-<host>-<port>` |
| `RIFFKIT_NO_UPDATE_CHECK` | Set to `1` to skip the daily check for a newer CLI (it is also skipped in CI) |

## Updates

New commands and options need no update: they come from Riffkit's list. For the CLI's own code, it asks npm at most once a day whether a newer `@riffkit/cli` is out and, if so, adds one line to stderr: `npm i -g @riffkit/cli@latest` updates it. It never installs anything by itself, and a check that gets no answer within 1.5 seconds is skipped silently.

The command list is kept in `~/.riffkit/cli-manifest-<host>.json` and checked with Riffkit again once the time Riffkit gives it (5 minutes) has passed; offline, the kept list is used.

## Other ways to use Riffkit

- **The web app** at [riffkit.ai](https://riffkit.ai).
- **The agent skill** at [riffkit.ai/SKILL.md](https://riffkit.ai/SKILL.md) teaches an AI agent (Claude Code, Codex, Cursor) how to make a video with Riffkit: when to quote, what to ask the user, how to write the creative direction. It talks to the same API; with this CLI installed, an agent can run these commands instead of writing HTTP requests, and the two share one sign-in.
- **The connector** for chat apps such as Claude and ChatGPT: nothing to install, you add Riffkit in the app and sign in there. [riffkit.ai/mcp](https://riffkit.ai/mcp) shows how.

## Development

`node --test` runs the tests. `test/fixtures/manifest.json` stands in for the command list Riffkit serves (`api/cli_commands.generated.json` in the app's repository); `RIFFKIT_APP_ROOT=<app checkout> node --test` checks the two are still the same.

## License

MIT
