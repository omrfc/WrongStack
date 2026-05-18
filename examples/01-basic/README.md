# 01 — Basic Usage

Simple examples to get started with WrongStack.

## Single-shot

Run a one-line task and exit:

```bash
wrongstack "explain what this project does"
wrongstack "list all TypeScript files in src/"
wrongstack "what Node.js version does this project require?"
```

## Interactive REPL

Start an interactive session:

```bash
wrongstack
```

Then type naturally:

```
> What framework is this project using?
> Show me the entry point
> Add a comment to the main function explaining what it does
```

## TUI mode

Rich terminal UI with live status bar, streaming text, and image paste:

```bash
wrongstack --tui
```

## Session resume

Continue where you left off:

```bash
# List recent sessions
wrongstack sessions

# Resume the most recent
wrongstack resume

# Resume a specific session
wrongstack resume abc123
```

## YOLO mode

Skip all permission prompts for fast iteration:

```bash
wrongstack --tui --yolo "add JSDoc comments to all exported functions in src/"
```

Toggle at runtime:

```
/yolo off    # re-enable prompts
/yolo on     # disable prompts again
/yolo        # check current state
```
