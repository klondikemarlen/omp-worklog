# Domain Model

## Terms

| Term | Meaning | Authority |
| --- | --- | --- |
| Project Time evidence | Persisted local interval records produced by OMP Project Time. OMP Worklog reads this data but does not define its format. | OMP Project Time |
| Human-active evidence | Evidence whose `sourceKind` is `human_active`; this is the default input to work-log drafts. | OMP Project Time and this repository's transform boundary |
| Local project | The exact Project Time project name recorded with evidence. It identifies the source-side work stream. | Evidence record |
| Activity | A label attached to an evidence segment. It helps group and explain work but is not an approved external task. | Evidence record |
| Work item | Optional issue or pull-request attribution attached to evidence. It provides review context, not a destination assignment. | Evidence record |
| Time-log record | The intended provider-neutral output: `project: task: duration`, built from reviewed Project Time evidence. | Product direction |
| Draft | A deterministic, review-only proposal derived from local evidence. It can contain a configured destination, but it has not written anywhere. | This repository |
| Mapping | Local configuration that maps a Project Time project to a Harvest project and task. It is a projection rule, not source evidence. | User configuration |
| Destination | An external system and its project/task identity. Harvest is the only supported destination today. | Destination adapter |

## Invariants

- Project Time evidence remains the source of measured duration and source-side project identity.
- Keep every positive measured duration in review output, including intervals too short to appear in rounded decimal hours. Duration precision is independent from a destination's rounding or billing policy.
- A missing, ambiguous, or unassigned destination never becomes an implicit Harvest assignment; the draft remains review-required.
- A mapping does not rewrite the source evidence or prove that an external task is correct.
- A generated narrative can help a person review a draft but cannot establish task identity or create a factual external note.
- External writes are separate from local analysis and require explicit invocation of a write-capable path.

## Boundary Example

A `wrap` evidence interval with an activity of `implementation` may become a reviewable local record. A configured `wrap → WRAP / Programming` mapping can add a Harvest destination to its draft. The measured duration and local `wrap` identity still originate in Project Time; the mapping does not convert them into Harvest-owned facts.
