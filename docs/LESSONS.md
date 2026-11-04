# Lessons from Alloy

Solder is a lean VS Code coding agent. It inherits about a year of hard-won lessons from **Alloy**, a Windows desktop assistant that runs against a corporate OpenAI-compatible gateway. This file holds those lessons in a form that is safe to publish. Nothing here names a company, gateway, address or model; deployment-specific facts stay in private notes outside the repo.

Each lesson gives:
- **What happened:** what we saw.
- **What to do:** what Solder does about it.
- **Code:** a snippet, where one helps. `src/gateway.js` is the working JavaScript port of Alloy's transport.

---

## 1. The wire: Chat Completions with tools

### 1.1 Request shape

Send the plain OpenAI Chat Completions shape, in this field order:

```js
{ model, messages, stream: true, tools, tool_choice: "auto", reasoning_effort?, max_tokens }
```

- `messages[0]` is `{role: "system"}`. After it come `user` messages, `assistant` messages (with `tool_calls` when the model called tools), and `tool` messages (`tool_call_id` and `content`).
- **The last message must be `user` or `tool`.** No prefill, and never end on an assistant turn.
- **Keep the field order.** One gateway was picky about the request shape. Alloy copied a known-good client's serialization exactly and never changed it again.
- Leave out `temperature`, `top_p`, `frequency_penalty`, `presence_penalty` and `n`. Some models ignore them; others reject them with HTTP 400.
- `reasoning_effort` (`low` / `medium` / `high`): leave it out for the model's default, which answered the same as `low` in probes. `high` gave about 1,000 reasoning tokens and roughly 4× the wait. Some providers reject `minimal` and any thinking budget.
- **`max_tokens`: 32,768 when nothing is set.** On thinking models the output limit covers the thinking as well as the answer, so a small limit gives empty replies.

### 1.2 Streaming: a tool call arrives whole, after a long silence

What happened:
- Text streams in small pieces, as usual. On at least one gateway, though, **each tool call arrives complete in a single chunk**, only once the model has finished writing it. There are no argument deltas.
- A call that writes a 5,000-token file is therefore **about 60 seconds of total silence** after the opening sentence.
- A 60-second client timeout killed 3 of 4 such tries.

What to do:
- **The timeout is quiet time on the socket, not total time: 480 s for tool requests.** A reply that keeps streaming never times out. Stop always works.
- **Show the wait.** Show "Thinking…" after 2.5 s of quiet, then "may be writing a long file…" after 15 s. On High effort, also show a running m:ss clock, so users don't mistake a long think for a hang.
- Still put pieces back together by `index` (`src/gateway.js` `ChatStream`), because other servers do stream arguments.

### 1.3 A stream isn't done until it says so

- **Done means both:** a `finish_reason`, and then `data: [DONE]`.
- **If the connection ends without them, the reply failed.** Keep the partial text and mark it unfinished. Never treat a cut-off stream as a complete answer.
- **Accept every line ending:** LF, CRLF and a bare CR. Skip `:` comment lines, and join multi-line `data:` fields.
- **Check sizes:** cap each event (256 KB) and the whole response (8 MB).
- A `finish_reason` of `tool_calls` with no calls is an unreadable reply. Text arriving after `finish_reason` is an error.

### 1.4 Ids and thought signatures go back exactly as they came

- **Every tool result answers its call by `id`.** A call with no id gets one made up (`call_<n>`), because the history must line up.
- **Gemini models attach `extra_content.google.thought_signature` to calls.** Their docs say a stateless client **must** send every one back exactly as received. Store whatever `extra_content` came with each call (size-capped) and resend it.
- **Every call needs an answer**, even one that didn't run. Give it a short stand-in such as `Not run: an earlier call in this reply failed`. A dangling call breaks the next request.

### 1.5 Empty replies

An empty reply (no text, no calls) is an error:
- **`length`:** the reply ran out of room. Not transient; say so to the user.
- **`content_filter`:** the gateway filtered the reply. Not transient; say so.
- **Anything else:** treat it as transient. When the empty reply answered a tool result, Alloy resent that result once with this note added: *"(Your reply to this came back empty, so here it is again. Please carry on: send your next tool request, or give me your answer.)"* The same message on its own tends to get the same empty reply again.

---

## 2. Failures and retries

### 2.1 Billed or not

Stateless tool models resend the whole chat on every request, so **a retry costs the whole chat again.** Sort failures by whether the model may already have seen the request:

| Failure | Model saw it? | Retry |
|---|---|---|
| 429, 503 (busy) | no | yes: backoff 1 s / 4 s / 8 s, or `Retry-After` up to 60 s |
| `Retry-After` > 60 s | no | no: "try again later" |
| other 5xx, timeout, connection reset | **maybe** | not in the client. The loop tries **once**, then stops with a Resume button |
| 4xx | n/a | no: show the cleaned error |
| 429 with the allowance at 0 | n/a | no: "used up, resets in …" |

- **Connection resets happen** (WinError 10054). Alloy saw two in about 120 requests on a healthy day. The single loop-level retry exists for these.
- **Never resend after text has reached the user.** Keep the partial text and offer Resume.

```js
// src/gateway.js: the retry decision
if (!error.transient || error.uncertain || streamed || error.exhausted || attempt >= this.maxRetries) throw error;
```

### 2.2 The allowance

- Gateways that meter usage often send `x-ratelimit-{limit,remaining,reset}-<bucket>` headers on **every** response, including errors. Read the tightest bucket and show it in a status bar item.
- **What happens when the allowance runs out hasn't been seen yet.** Solder assumes a 429 with `remaining: 0` means used up. Confirm the real response the first time it happens, and log the status, body shape and headers (numbers only).

### 2.3 Clean every error before showing it

Error bodies can repeat the key, internal host names and IP addresses. Before any error text reaches the user, the UI or a log:
- replace the key and any `Bearer …` value;
- replace URLs, dotted host names and IPv6-looking strings;
- strip control characters;
- cap it at 500 characters.

Never show a proxy's HTML page: fall back to "HTTP 502". (See `GatewayClient._clean`.)

### 2.4 Logs

- **Log names and numbers only:** tool names, outcomes, durations, byte and token counts, HTTP status, finish reason, and each attempt's `cause: headers after N ms, B bytes, T ms`.
- **Never log** paths, commands, file contents, prompts, keys or endpoints.
- An optional raw debug log (off by default) keeps the newest 300 exchanges.

---

## 3. The tool loop

Alloy's `ReplyWorker.tool_loop`, cut down to what Solder needs:

```text
loop:
  reply = gateway.reply(system + history, tools)        # streamed
  if reply has no calls: done (the answer is the text)
  for each call, in order (up to 5 per reply; 8 if all are read-only):
      problem? (unknown tool, bad args, a repeat in the same reply) -> answer it with the problem, keep going
      needs approval? -> ask; declined -> answer "declined" (+ the user's note), stop the batch
      run it -> result (capped), with Undo kept for edits
      failed and not read-only -> stop the batch; answer the rest "Not run: …"
  history += assistant(calls) + one tool message per call
  rounds += 1; near the limit (3 left) -> tell the model to wrap up; at 30 -> stop with a summary
  steer: messages the user typed while it worked ride along on the last result
  trim (§5), then loop
```

The rules behind it:
- **Batches.** Several calls in one reply save round trips, and every round trip is billed in full. Calls run in order. A failure or a decline stops the batch, because later calls usually depend on it. **A failed read doesn't stop later reads.**
- **Count rounds, not calls.** The step limit counts replies that contain calls, because each request is what costs.
- **Never run a repeated call twice.** A call identical to an earlier one in the same reply gets "Not run again: same call as earlier (see its result)."
- **Calls that can't run are answered, not dropped.** An unknown tool or a missing or wrong-typed argument gets an answer that names the problem and, for an unknown tool, lists the tools on offer. The other calls in the reply still run. Models recovered from deliberately broken calls within one round.
- **Truncated calls** (`finish_reason: length` mid-call) get: "cut off at the length limit; send it again in smaller parts (write the first part, then append)."
- **Script streaks.** After 6 shell runs in a row with nothing else between them, add: "That's 6 scripts in a row. Put whatever you still need into one final script, or go ahead." In Alloy, models given only a shell chained dozens of small scripts.
- **Wrap-up.** With 3 or fewer rounds left, every result says how many are left. At the last one, it says to answer now with what's done and what's left. A model can't know the limit on its own, and stopping it mid-task without a summary loses the work.

---

## 4. Tools: few, typed, purpose-built

- **Purpose-built tools win, by a lot.** Alloy measured one job both ways: ~20 Python calls and ~1M tokens with only a shell, versus **one call and ~10k tokens** with a typed tool. When a recurring kind of task appears, build a narrow tool for it rather than tuning prompts to steer scripts.
- **Shell bias.** Tool-calling models tend to reach for a shell or script even when a dedicated tool exists. The shell tool's description must say so: *"Use it only for what the other tools can't do; never to read, list, find or search files (read_file, find_files and search do that without approval)."* The system prompt repeats the rule in one line.
- **Typed arguments.** Integers, booleans, arrays and enums in the JSON Schema come back typed. Give every argument a one-line description.
- **Fewer tools.** Every request resends every definition, so 38 tools cost about 5k tokens per round trip. Alloy dropped to 22 by putting rarely used tools behind "skills" that unlock them. Solder starts with 7.
- **Edits.** `old_text` must appear **exactly once**. When it doesn't, say how many times and on which lines, so the model can add context. Keep the file's own line endings (models write `\n`). If the only difference is trailing whitespace on lines, still accept the edit when that match is unique.
- **Results.** Return a compact summary line for the UI plus the output for the model. Cap output at 30k characters, and for long output keep the head and the tail with a note.
- **"Never guess what a file says or what a command did: wait for the result."** This line earned its place in the prompt.

---

## 5. Token budget: what actually burns the allowance

**A stateless tool model resends the whole chat on every round trip.** The cost of a task is roughly *(chat size) × (round trips)*. A 150k-token chat that takes 20 steps costs 3M tokens, and one user really did spend a whole daily allowance in half an hour. Everything below follows from that.

1. **Shrink old tool results.**
   - Within one answer, keep the newest results whole up to about 30k tokens. Replace older large ones (over 2,000 characters) with a one-line stand-in: *"I ran that earlier (summary). Left out to save space; read it again if you still need it."*
   - Results from earlier answers get the same stand-in.
   - The full text stays on screen.
2. **Trim in batches, not every step.** Let results overshoot the budget by about 10k tokens, then cut them all back at once. That keeps the start of the history unchanged for longer, which a prefix cache can reuse (see 4).
3. **Compact.** When the chat's estimate (characters ÷ 4) passes a threshold, ask the model for a summary as an ordinary user turn. The request text Alloy uses is in [§5.1](#51-compaction-request-alloys-wording) below. Then replay the history as [that request, the model's summary] followed by the newest fifth of the chat word for word, cut just before a user message.
   - The threshold should be **far lower for stateless models** than for stateful ones.
4. **A stable prefix.** Keep the system prompt the same from request to request:
   - no time of day in it (put the date on each user message instead);
   - no folder listings (sizes change).

   Order the tool definitions the same way every time, and only append to the history. In one probe a repeated 31k-token opening came back 93% cached. **Caveat:** a gateway may cache without passing the discount on to your allowance, so caching helps speed for certain but your quota only perhaps. Don't trade size for cache hits.
5. **Small outputs by design.** The prompt says: "Every result is sent again with each later step, so keep outputs small: filter or count inside a command, and look at a big file's shape before reading it whole."
6. **Search restraint.** Models given a search tool search four or five times on brand-new tasks, widening the query each time until they pull in unrelated matches. What fixed it:
   - a no-match result that says *"nothing earlier to go on, so this is probably new work: carry on without it rather than searching again with other words"*;
   - flagging "loose matches" when the best hit matches only a few of the query's words;
   - the rule "search once at most for new work".
7. **Show the cost.** Show tokens spent per answer and per chat, and the allowance left. Users change their habits when they can see it.

### 5.1 Compaction request (Alloy's wording)

> Before we continue, please write a summary of our conversation so far that could stand in for the full history. Keep my goals and preferences, key facts, decisions and conclusions, open questions, and any code, commands, file names, numbers or exact values that may matter later. Be concise but complete, use short headings and bullet points, and reply with only the summary.

---

## 6. Prompting a tool-calling model

- **Short wins.** Every reference harness looked at uses under about 1,000 tokens of prompt: OpenCode's default prompt, Pi, mini-SWE-agent and DeepSeek's minimal preset. Use second person ("You are…"), one rule per habit, and say "dedicated tools before shell".
- **No reasoning in the reply.** Some thinking models start "thinking out loud" in the visible reply several turns into a long chat ("WAIT", "HOLD ON", pages of drafts), probably by copying their own earlier style from the history. The rule *"The user reads your reply as it is: don't put your reasoning, drafts or second thoughts in it"* plus "before a tool call, write one short sentence at most" keeps that down.
- **Avoid unstructured text before tool calls** (from Google's guidance for Gemini models). Prefer sequential tool turns.
- **Each user message starts with the local date and time**, for example `(Tuesday 4 November 2026, 14:05)`. This keeps the time out of the system prompt.
- **Don't fake turns.** Never invent assistant messages. Some gateways ignore them silently, and some models treat them as an attack. A summary is requested from the model, never written for it.

---

## 7. Corporate Windows realities

- **PowerShell may run in Constrained Language mode** (AppLocker/WDAC). `.NET` method calls, `Add-Type`, `New-Object` and many `[Type]::Method()` calls fail there. Detect the mode once with `$ExecutionContext.SessionState.LanguageMode` and tell the model in one line when it applies.
- **Scripts in AppData may be blocked** by policy. Never write a helper script there and run it.
- **Output encoding:** ask PowerShell for UTF-8 output (`[Console]::OutputEncoding` can't be set in CLM). Read output as bytes and decode leniently.
- **Proxies:** inside VS Code, use `node:http`/`node:https`, which the extension host routes through VS Code's proxy settings. Test the gateway from inside the extension host on day one (`Solder: Check connection`), not from a terminal.
- **Destructive commands** never run automatically, even with "always allow". Alloy keeps a destructive-command check (Remove-Item -Recurse, Format-, git reset --hard, and so on) that always asks.

---

## 8. Things that looked like good ideas and weren't

- **A review subagent for scripts.** Side requests to a slow gateway took 15–150 s and timed out. Dropped.
- **Synthetic history to test a gateway.** It looks adversarial and the results mislead. Probe with real turns instead.
- **Rewriting old turns every step.** It breaks any server-side session or prefix cache. Rewrite in batches, or not at all.
- **Supporting formats that can't be made exactly reliable.** If it can't be made extremely reliable, don't support it.
- **Retrying everything.** With stateless billing, a blind retry loop multiplies the cost of a flaky hour.
