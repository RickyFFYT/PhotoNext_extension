# PhotoNext on the Minotaur engine

PhotoNext is not a photo editor with a chat box bolted on, and Minotauris is not a chat box
with tools bolted on. Both are built the other way round — which is why the combination is
worth more than the sum of a tool list.

This document is about the second half: what the surface in this repository becomes when it
is driven by Minotauris' agent team runtime instead of a single model in a single loop.

---

## 1. What the engine actually gives a tool surface

Minotauris runs **one runtime at one depth** with three roles. The ids stay
`leader` / `manager` / `worker` in code and on the wire; the names the model sees are
functional.

| Role | Model-facing | Owns |
|---|---|---|
| `leader` | **Coordinator** | Plans the mission, delegates, verifies the outcome, answers directly when it can |
| `manager` | **Supervisor** | One domain: plans and delegates inside it, reviews executor output, reports upward |
| `worker` | **Executor** | Executes the assignment — files, terminal, browser, desktop, MCP, extension tools |

Executors are chartered for focused work. A Supervisor is added only when a mission genuinely
splits into independent domains. There is no mode switch: Prism review, structured visual
responses and verified completion are always available.

For a photo mission that means the shape of the work changes:

- The **Coordinator** takes "make these 40 product shots consistent and export IG crops",
  decides it is one domain with parallel documents, and charters executors.
- A **Supervisor** holds the *look* — the reference curve, the white-balance target, the
  export matrix — and reviews what comes back before it is reported.
- Each **Executor** drives one document through the tools in this repo.

None of that required a line of PhotoNext code. The extension exposes 29 MCP tools; the
engine exposes a team.

---

## 2. The seam: MCP, not a private API

An installed extension appears to the agent as an `ext-<extension-id>` MCP server. Its tools
reach the model exactly like any other server's — `mcp.<server>.<tool>` — and the engine
wakes the process on first call, so a tool learned in an earlier turn still works from cold.

Two consequences that matter for a 29-tool extension:

1. **Adding a tool costs the engine nothing.** No `executeTool` case, no engine change, no
   release coupling. `photo_effect` gaining a 21st effect is a file in `server/effects.cjs`.
2. **The visible surface is a budget, not an accident.** Role tool lists are a deliberate
   latency budget with hard ceilings asserted in the app's engine test suites. PhotoNext
   does not inflate a prompt with 29 schemas; it is one line in `## Installed extensions`
   plus the skill, and tools are reached by name when needed.

The skill is the other half of that seam. `skills/photo.md` is 553 lines of the things a
model cannot infer: parameter ranges, the fixed order of `photo_edit`, that a group's style
paints against its isolated composite, that a compound path is one call and twenty brush
strokes is the wrong shape of work. The Coordinator can read it with `extensions.skill`;
attaching the extension with `@` puts it in context for free.

---

## 3. Todos: why a 12-step edit needs them

Every agent has a first-class todo list (`todos.create` / `update` / `delete` / `list`),
scoped per agent, visible upward: the Coordinator sees everything, a Supervisor sees its own
and its executors', an executor sees peers under the same supervisor.

Photo work is exactly the shape todos exist for:

```
photo_import            → import the source
photo_status            → read the canvas, layer tree, histogram
photo_adjust            → neutralise the cast (white balance + levels)
photo_select + adjust   → mask the skin, tame the highlights
photo_effect            → oil paint at 40%, previewed first
photo_text3d            → add the headline
photo_preflight         → 1080×1350, sRGB, no live styles that would clip
photo_export            → artifacts/{stem}-ig_post.jpg
```

Eight steps that must not be reordered and must not be silently dropped. Todos are how an
agent that gets interrupted at step 5 knows it is at step 5 — and how a Supervisor reading
its board knows the executor is not done, without polling the document.

They are local-first by design: in memory in `TodoStore`, serialised with the rest of the
board snapshot to local JSON, restored on relaunch. No database row per checkbox.

---

## 4. Structured answers instead of markdown

The model does not answer with generated HTML. `ui.render` takes text plus a `view` whose
kind is one of `metrics`, `bars`, `chart`, `table`, `list`, `card`, `timeline`, `callout`,
`diff`, `prism`, and the app draws it natively. A malformed view degrades to the text answer
rather than breaking the thread.

PhotoNext's inspection tools exist to feed that:

| Question the user asks | What the agent renders |
|---|---|
| "Did that change anything?" | `diff` — `photo_diff` returns changed bbox, changed-pixel share, MAE/RMSE/PSNR/SSIM |
| "How bad is the clipping?" | `bars` — `photo_sample` histogram bins and channel means |
| "What's in this document?" | `table` — `photo_describe` layer tree: id, kind, frame, blend, opacity |
| "Which presets will this export to?" | `table` — `photo_preflight` dimensions, DPI, colour space, bytes |
| "Show me the crop" | `card` / image — `photo_region` at 2–4× |

That is the difference between an agent that says "I brightened it" and an agent that shows
the changed-pixel share and the bbox it landed in.

---

## 5. Review before delivery

`prism.consult` is available to the Coordinator at any time, and a Supervisor can review an
executor's output (`review_worker_output`) before it goes anywhere.

For images this is not ceremony. `photo_diff` answers *what changed*, `photo_preflight`
answers *will this survive delivery*, and `photo_bounds` answers *is this centred on ink or
on a transparent frame* — the classic wrong answer when a logo is centred by bounding box.
A reviewer with those three calls can reject a deliverable on evidence rather than vibes.

---

## 6. The revision contract is what makes parallel agents safe

`photo_recipe` batches calls into one undo group (`atomic: true` rolls back the whole group),
but the more important contract for a team is the revision one:

- every mutating call returns `revision_before` / `revision_after`;
- `if_revision` turns a stale edit into `REVISION_CONFLICT` with the changed layers and a
  `suggested_call`;
- `op_id` makes a retried call idempotent;
- errors carry `code`, `field`, `received`, `allowed`, `candidates`, `suggested_call`.

This is optimistic concurrency for pixels. Two executors must not quietly overwrite each
other's work, and a Supervisor can hand out "edit the background" and "edit the headline" as
two assignments knowing the loser of a race gets a recoverable conflict instead of a lost
edit.

---

## 7. One document, many surfaces

The panel is filed per chat, which is a small detail with a large behavioural consequence: a
background board can work on a photo while the user reads a different conversation, and the
editor does not materialise over the wrong thread. Closing the panel does not stop the
process or change the document; the next `photo_*` call reopens it.

Everything the panel can do is a tool the agent can call, so a user who prefers to drive the
brush by hand and a user who prefers to ask are operating the same document through the same
code path. That is the property that makes an "agent-first" panel honest rather than
decorative.

---

## 8. Capability boundaries hold under a team

The manifest asks for `filesystem: "extension-data"` and `tools: true`, nothing else. The
process runs with `PATH=/nonexistent`, the backend is required by path, and every write it
makes lands inside its own data directory. `photo_export` is the single step that writes
outside the editor, and it is the one the user is asked about.

A team of agents does not widen that. Three executors in one mission still get one extension
data directory, one explicit export approval, and no ambient authority — which is why
chartering a second executor is a scheduling decision rather than a security one.

---

## 9. Where the leverage is measurable

Not "the agent can edit photos" — that is table stakes. The measurable gains are:

1. **Turns per edit.** `photo_draw` takes a whole compound path plus its detail stroke in one
   call; `sketch` takes up to 32 tapered strokes with symmetry; `photo_recipe` takes a batch as
   one undo group. The skill is written to stop the 20-call silhouette.
2. **Verification cost.** `photo_diff` / `photo_delta` / `photo_bounds` / `photo_preflight`
   answer "did it work" without re-reading a 12 MP document or re-running the edit.
3. **Recovery cost.** Revision conflicts and `suggested_call` errors are one-step recoveries,
   not re-plans.
4. **Throughput.** One Supervisor plus N executors across N documents beats one agent doing
   them in sequence, and the look stays consistent because the Supervisor owns the reference,
   not each document.
5. **Serialisation.** Todos and notes mean a mission can pause and resume without re-deriving
   what it already did.

---

## 10. What this still cannot do

The engine cannot make PhotoNext do what PhotoNext does not implement. No content-aware fill,
no generative fill, no RAW develop, no CMYK, no PSD round-trip, no 3D animation, no editable
shape layers, one static 3D scene per document, one font/colour run per text layer. `dehaze`
and `clarity` are approximations; gaussian blur is three box passes; the preview is JPEG at
1400 px.

On the engine side, the one structural limit worth naming: `App.tsx` and `engine.ts` are the
app's two monoliths, and the rule there is *extract, never expand*. Runtime-contributed tools
register a tool provider; they do not add cases to `executeTool`. PhotoNext respects that by
being an extension at all — it is a socket, not a graft.
