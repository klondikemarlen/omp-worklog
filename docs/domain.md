# Domain Model

## Terms

| Term | Meaning | Authority |
| --- | --- | --- |
| Project Time evidence | Persisted local interval records produced by OMP Project Time. OMP Worklog reads this data but does not define its format. | OMP Project Time |
| Human-active evidence | Evidence whose `sourceKind` is `human_active`; this is the default input to work-log drafts. | OMP Project Time and this repository's transform boundary |
| Agent-turn evidence | `agent_turn_elapsed` lifecycle intervals, distinct from human windows and not a measurement of CPU time or continuous progress. | OMP Project Time |
| Concurrent-work candidate | A within-project union of observed human/agent intervals plus review-marked same-session response gaps; different projects remain independent. | Worklog policy |
| Local project | The exact Project Time project name recorded with evidence. It identifies the source-side work stream. | Evidence record |
| Activity | A label attached to an evidence segment. It helps group and explain work but is not an approved external task. | Evidence record |
| Work item | Optional issue or pull-request attribution attached to evidence. It provides review context, not a destination assignment. | Evidence record |
| Time-log record | The intended provider-neutral output: `project: task: duration`, built from reviewed Project Time evidence. | Product direction |
| Draft | A deterministic, review-only proposal derived from local evidence. It can contain a configured destination, but it has not written anywhere. | This repository |
| Review batch | Private project/day records with candidate duration, reviewer-adjusted duration, destination, factual notes, and explicit approval state. | Human review and this repository |
| Submission receipt | Private record of a pending or completed destination create used for reconciliation and safe retry handling. | Harvest adapter |
| Mapping | Local configuration that maps a Project Time project to a Harvest project and task. It is a projection rule, not source evidence. | User configuration |
| Destination | An external system and its project/task identity. Harvest is the only supported destination today. | Destination adapter |

## Invariants

- Project Time evidence remains the source of measured duration and source-side project identity.
- Keep every positive measured duration in review output, including intervals too short to appear in rounded decimal hours. Duration precision is independent from a destination's rounding or billing policy.
- A missing, ambiguous, or unassigned destination never becomes an implicit Harvest assignment; the draft remains review-required.
- A mapping does not rewrite the source evidence or prove that an external task is correct.
- A generated narrative can help a person review a draft but cannot establish task identity or create a factual external note.
- External writes are separate from local analysis and require explicit invocation of a write-capable path.
- Concurrent projects may retain independent approved durations while each provides meaningful value and the user is not blocking it; there is no global cross-project hour cap.
- Overlapping source kinds or sessions within one project do not multiply its candidate duration. A same-session response gap may be inferred only within the selected grace, five minutes by default.
- Historical elapsed intervals cannot establish progress, waiting-on-user state, or dormancy. Candidates stay review-required; approval confirms the reviewed duration and note, not a new claim about the original evidence.
- A batch approval authorizes only its reviewed snapshot. Stable project/day identities prevent a changed snapshot from silently creating a second entry.

## Boundary Example

A `wrap` evidence interval with an activity of `implementation` may become a reviewable local record. A configured `wrap → WRAP / Programming` mapping can add a Harvest destination to its draft. The measured duration and local `wrap` identity still originate in Project Time; the mapping does not convert them into Harvest-owned facts.

Two projects making progress from 09:00 to 10:00 can each have a one-hour reviewed record. Human and AI observations of that same hour within one project produce one candidate hour, not two. A later response within five minutes may create a review-marked gap; an unanswered or dormant session must be reduced or excluded during review. See the [reviewed concurrent workflow](/docs/billing.md).
