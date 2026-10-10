# session-namer

A [Claude Code](https://claude.com/claude-code) mod that suggests a name for your session, following **your** naming convention.

After each Claude reply, Haiku reads the conversation (your messages and Claude's text replies, no tool output) and suggests 3 names in a band above the prompt:

```
Session name: [ feat/clmod-mod: implement session namer ] [ … ] [ … ] [ Reroll ] [ Dismiss ] [ Stop ] ≈$0.0003 (2.6k tokens) · session …
```

Click one to rename the session (`/rename`). Once a name is picked or dismissed, the band stays hidden until the topic of the conversation actually changes. **Reroll** asks for 3 different names; **Stop** turns the suggestions off for the rest of the session.

## Install

In a Claude Code terminal session:

```
/plugin install session-namer --marketplace lucaslenglet/session-namer
```

Answer `y` to add the marketplace, pick a scope (user scope = every session), then set the options (or keep the defaults). The mod is active right away.

## Usage

| | |
|---|---|
| Band above the prompt | Click a name, or `ctrl+x tab` then `1`-`3`; `r` rerolls, `x` dismisses, `s` stops for this session |
| `/rs` | Ask for suggestions now (different ones if the band is shown); works even when stopped |
| `/rs stop` / `/rs start` | Turn automatic suggestions off / back on for this session |
| `/rs help` | How it works, your current settings and a live preview of the format |
| `/rename …` | A manual rename is remembered too: no suggestion until the topic changes |

## Settings

In `/config`, search for `session name`:

| Setting | Default | |
|---|---|---|
| **Session name format** | `{type:L}-{id}/{project:L:,5}-{kind:L}: {desc:L:w2,5}` | How names are built |
| **Session name rules for Haiku** | *(empty)* | Free text that overrides the default rules, e.g. `description in French; allowed types: feat, fix, chore` |
| **Session name project code** | *(empty: derived from the folder name)* | Fixed value for `{project}` |
| **Session name cost display** | on | Show the Haiku cost in the band and in `/rs` (`/rs help` always shows the session total) |

### Format

Text is kept as typed; each `{field}` is replaced by a value Haiku finds in the conversation. An empty field disappears together with the separator next to it.

| Field | Meaning | Filled |
|---|---|---|
| `{type}` | kind of work item: bug, us, pr, feat… | only if stated |
| `{id}` | its ticket / PR number | only if stated, never invented |
| `{project}` | project code (`ClaudeMods` → `clmod`, `prompt-optimizer` → `propt`) | always |
| `{kind}` | kind of project: f (front), b (back), cli, mod, script… | only if clear |
| `{desc}` | what you are doing, e.g. `init spec`, `plan tests` | always (required) |

With the default format:

```
bug-1234/clmod-f: fix login redirect
clmod-cli: plan tests
clmod: init spec
```

### Field options

`{field:option:option|fallback}`, options can be combined:

| Option | Effect | Example |
|---|---|---|
| `U` `L` `C` | UPPER, lower, Capitalized | `{type:U}` → `BUG` |
| `K` `S` | kebab-case, snake_case | `{desc:K}` → `init-spec` |
| `3` `2,5` `,5` `3,` | length in characters: exact, min-max, max, min (cut / padded) | `{type:3}` → `fea` |
| `_x` after a length | pad with `x` on the left | `{id:4,_0}` → `0042` |
| `w2,5` `w,3` `w3` | number of words | `{desc:w,3}` |
| `[a,b,c]` | allowed values; anything else counts as empty | `{type:[bug,us,pr]}` |
| `\|text` | value used when the field is empty | `{kind\|gen}` → `gen` |

Haiku is told about lengths and allowed values, so it picks words that fit instead of being cut. Example of another convention:

```
[{project}] {desc:C:w,5} ({type:U:[FEAT,FIX,CHORE]} #{id:4,_0})
→ [clmod] Fix login redirect (FIX #0042)
```

## Cost and privacy

One small Haiku call per Claude reply (low effort, at most ~12,000 characters of conversation: the first message plus the most recent ones), through your own Claude Code session like any other request. Subagent turns and interrupted turns are skipped.

The band, `/rs` and `/rs help` show what it costs (turn it off with **Session name cost display**): the call behind the current suggestions and the session total, which also counts calls that changed nothing on screen:

```
≈$0.00031 (2.6k tokens) · session ≈$0.0021 (17k tokens, 7 calls)
```

The dollar figure is an estimate at Claude Haiku 5.5 API rates ($0.10 / $0.50 per million input / output tokens). On a Claude subscription you are not billed per token: the calls count toward your usage limits instead.

## Development

```sh
claude plugin validate .
claude plugin test .
claude --plugin-dir .   # run Claude Code with this working copy loaded
```

- `hooks/register.tsx`: hooks, the band, the `/rs` command
- `hooks/naming.ts`: project code, template engine, Haiku prompt (pure functions)
- `tests/`: `claude plugin test`

## License

MIT
