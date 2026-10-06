---
"@promptowl/contextnest-engine": patch
---

**Approving a held edit rebuilds the approved content once.** `approveReview` (used by `ctx review approve`, the review gate and the MCP review tools) rebuilt the document's approved content once to check its holds and again to apply the chosen hold, each time reading the version history twice. It now rebuilds it once and reuses it, and the rebuild uses the history it already read: five history reads become two, and the keyframe-and-diff replay runs once instead of twice. Stacking a new held edit (`currentReviewProposal`) and staging one (`stageReviewHold`) benefit the same way.
