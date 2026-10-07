---
"@promptowl/contextnest-engine": patch
"@promptowl/contextnest-cli": patch
"@promptowl/contextnest-mcp-server": patch
---

**Full-text search ignores stopwords, weights titles, and drops weak partial matches, so a natural-language question retrieves the nodes about its topic.**

Hosts pass the user's question straight through as the search text. Words like "what", "is", "the" and "for" were indexed and OR-matched, so every node containing "the" came back as a hit, and chat hosts cited them. `Resolver.search` (behind `context_search`, `ctx search`, and `contextnest://search/…` in `context_query`) now drops English stopwords from both the index and the query, boosts title (×3), tags (×2) and description (×1.5) over body, and drops partial hits scoring below 5% of the best hit. Documents matching every query term are always kept. A query made only of stopwords returns nothing.
