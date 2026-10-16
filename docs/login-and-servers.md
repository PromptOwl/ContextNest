# Logging in to a server

`ctx login <server>` signs you in once. The key goes to the OS secure store (never `config.yaml`) and the
server is added to your vaults, so every nest you can see there is usable immediately.

```bash
ctx login https://nest.promptowl.ai        # browser sign-in, registers "promptowl"
ctx vault list                             # promptowl [server], promptowl/<nest>, …
ctx --vault promptowl/<nest> list          # one nest
ctx --vault promptowl search "billing"     # every nest on the server (reads)
```

## What gets registered

One entry per server, marked as a server:

```yaml
remotes:
  promptowl:
    transport: http
    url: https://nest.promptowl.ai/mcp
    scope: server        # server = many nests; nest = one /nests/<id>/mcp endpoint
```

The nests are not stored. `ctx vault list` asks the server each time (cached a few minutes), so nests you are
added to later appear on their own. If the server can't be reached the list shows the last known nests with
"not answering"; if it rejects the key the row says "key rejected — ctx login <url>".

| You want | Use |
|---|---|
| One nest | `--vault <alias>/<nest>` (nest = slugged name or id; two alike names become `<slug>-<id8>`) |
| Read across the server | `--vault <alias>` |
| Write | name a nest: `--vault <alias>/<nest>` (a bare server alias lists the choices) |

The server entry never becomes your default unless it is the first vault you have. Without `--vault`, `ctx`
keeps using your default vault.

## Options

- `--as <alias>` name it yourself; otherwise derived from the host (`localhost:3737` → `localhost-3737`, repeats → `-2`).
- `--no-register` save the key only. `--account <name>` keep a second identity on one server (registers its own alias).
- `--nest <id> --key-stdin` a key for one nest. Registers nothing; add it with `ctx vault add <alias> --url <server>/nests/<id>/mcp`.
- `ctx vault rename <old> <new>`, `ctx vault remove <alias>`, `ctx logout <server>` (the alias stays; remove it separately).

## Logged in before this existed?

You have a key but no registry entry. At a terminal, every command prints one line until you fix it:

```
ctx: logged in to https://nest.promptowl.ai but no vault is registered for it — run: ctx vault add promptowl --url https://nest.promptowl.ai/mcp   (silence: ctx hints off)
```

Run the command it prints, or `ctx login <server>` again. Silence it with `ctx hints off` (`ctx hints on` to restore)
or `CONTEXTNEST_NO_HINTS=1`. It never prints for pipes, agents, CI or `--json`.

## When the key stops working

The error names the exact command: `ctx login https://nest.promptowl.ai` (plus `--account <name>` when the alias
uses one; a nest-scoped key asks for `--nest <id> --key-stdin`). Shortcuts:

- `ctx login <alias>` signs in again for a registered alias.
- At a terminal, `ctx` offers "Sign in again now?" and then runs your command.
- Old keys stay valid on the server until you revoke them in its web UI → Connect. Revoke ones you no longer use.

`ctx doctor` lists every login, whether an alias uses it, and `ctx login --list [--json]` shows the same without
printing keys.
