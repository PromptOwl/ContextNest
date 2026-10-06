---
"@promptowl/contextnest-engine": patch
---

**Rebuilding a past version reads its files together.** Reconstructing a version read its keyframe and then each diff after it one at a time — up to ten back-to-back reads, each a round trip on network-backed storage. The files it needs are known from the history up front, so they are now read together, up to ten at a time, and applied in the same order — a window is applied and released before the next is read, so memory stays bounded however long the replay. Every publish rebuilds the previous version to compute its diff, so this shortens every publish, as well as version reads and integrity checks. Results and errors are unchanged: a missing or unreadable file fails at the same point it did before.
