# Live tests

Solder's engine, prompt and edit matching against a real model, through any OpenAI-compatible endpoint (a local
proxy, say), on throwaway workspaces. The tools that need VS Code are stood in for by plain file work; JavaScript
files get a real syntax check, so a broken edit shows up as new problems, as it would in the editor.

```
node live/run.js --model <id> [--runs 3] [--only typo,rename] [--skip bugs12] [--parallel 4]
                 [--src <a copy of src/>] [--label name] [--baseline label] [--endpoint <url>] [--effort low]
```

- **Endpoint:** `--endpoint`, or `SOLDER_LIVE_ENDPOINT`, or `http://127.0.0.1:8789/v1/chat/completions`. The key is
  `SOLDER_LIVE_KEY` (or `test`).
- **A before and after:** run a copy of the old `src/` with `--src` and `--label before`, then the new one with
  `--baseline before`; the table shows both.
- **Results:** `live/results/<label>.jsonl`, one line per run (not in git).
- **The Assist lane:** `--tool-models <regex>` makes every model that doesn't match an Assist model (plain text, tool requests
  written in the reply). With no `--assist-block`, there are no sessions: every request carries the conversation over.
- **The Assist lane's failures, made to happen:** `--cut N` stops the task's Nth reply partway (its stream ends with no finish), and
  `--break N` takes the arguments out of the second request of the Nth reply that holds two or more. The run then shows whether
  the task still got done: each line says how often a request was asked for again, a cut reply carried on from, and the
  model told of requests that didn't run.
- **What a line and the table show:** tokens, requests, failed calls, and failed edits (`edit✗`: a first-try edit that missed). A line
  also says how many of the edits landed, and the most changes one reply made.
- **Cost:** a light scenario is 5–40k tokens a run; `bugs12` is about half a million. Skip it with `--skip bugs12`.

- **More than one message:** a scenario's `then` lists follow-up messages sent in the same chat. `task` and each `then` may be a
  function of Solder's own texts, to send what a slash command sends (`(prompt) => prompt.SKILL.fromChat`).
- **Skills:** a scenario with `skills` gets them in a folder beside the workspace, offered as Solder offers the user's,
  and a read of one goes through Solder's own skill read. The table's rows show which skills were read.

Each scenario (`live/scenarios.js`) sets up files, gives a task, and checks the outcome on disk by running the
code, not by reading the answer. Some change a file under the model on purpose (`hooks`) to test recovery.
