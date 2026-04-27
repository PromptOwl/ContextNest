/**
 * Starter recipes for Context Nest vaults.
 *
 * Content mirrors https://github.com/PromptOwl/context-nest-starters
 * Each starter provides scaffolding (nodes, packs) and a post-init prompt
 * that AI agents read from stdout to interactively generate a tailored CONTEXT.md.
 */

import {
  getPostInitPrompt,
  getDeveloperPostInitPrompt,
  getPersonalPostInitPrompt,
  getDefaultMaintenanceDirective,
  getDeveloperMaintenanceDirective,
  getPersonalMaintenanceDirective,
} from "./agent-config-base.js";
import type { PostInitPrompt } from "./agent-config-base.js";

export interface StarterNode {
  /** Relative path without .md, e.g. "nodes/architecture/architecture-overview" */
  path: string;
  /** Full markdown content including frontmatter */
  content: string;
}

export interface StarterPack {
  /** Pack filename without extension */
  id: string;
  /** YAML content for the pack file */
  content: string;
}

export interface Starter {
  id: string;
  name: string;
  description: string;
  nodes: StarterNode[];
  packs: StarterPack[];
  getPrompt(): PostInitPrompt;
  /**
   * Maintenance directive written to .context/config.yaml at init time.
   * `ctx index` reads it and emits it into the agent config managed
   * section so every session reminds the agent to keep the nest growing.
   */
  getMaintenanceDirective(): string;
}

// ─── Developer Starter ─────────────────────────────────────────────────────────

const developer: Starter = {
  id: "developer",
  name: "Developer / Engineering",
  description: "Architecture decisions, coding standards, and project knowledge for engineering teams",
  nodes: [
    {
      path: "nodes/architecture/architecture-overview",
      content: `---
title: Architecture Overview
type: context
tags: [architecture, overview, tech-stack]
priority: high
status: draft
---

# Architecture Overview

## System Overview

_Describe the system at a high level. What does it do? Who uses it?_

## Tech Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| Frontend | | |
| Backend | | |
| Database | | |
| Auth | | |
| Hosting | | |
| CI/CD | | |
| Monitoring | | |

## Architecture Diagram

\`\`\`
[Client] → [API Gateway] → [Service Layer] → [Database]
                         → [External APIs]
                         → [Message Queue] → [Workers]
\`\`\`

_Replace with your actual architecture._

## Key Design Decisions

### 1. [Decision Name]
- **Context:** _What was the situation?_
- **Decision:** _What did we decide?_
- **Consequences:** _What are the trade-offs?_
- **Alternatives considered:** _What else did we evaluate?_

## Repository Structure

\`\`\`
/
├── src/
├── tests/
├── docs/
└── ...
\`\`\`

## Environments

| Environment | URL | Purpose |
|------------|-----|---------|
| Development | | Local development |
| Staging | | Pre-production testing |
| Production | | Live system |
`,
    },
    {
      path: "nodes/onboarding/getting-started",
      content: `---
title: Developer Getting Started Guide
type: context
tags: [onboarding, setup, getting-started]
priority: high
status: draft
---

# Getting Started

## Prerequisites

_List what a new developer needs before they can start:_
- [ ] Access to source control (GitHub / GitLab / etc.)
- [ ] Development environment set up (IDE, runtime, etc.)
- [ ] Access to staging/development environments
- [ ] Added to team communication channels
- [ ] Local dependencies installed

## Setup Steps

\`\`\`bash
# 1. Clone the repo
git clone <repo-url>

# 2. Install dependencies
# (add your actual commands)

# 3. Set up environment
cp .env.example .env
# Fill in required values

# 4. Run locally
# (add your actual commands)

# 5. Run tests
# (add your actual commands)
\`\`\`

## First Tasks

Good first issues for getting familiar with the codebase:

1. _Fix a small bug or typo_
2. _Add a unit test for an existing function_
3. _Update a piece of documentation_

## Key Files to Read First

| File | Why |
|------|-----|
| | _Entry point — understand how the app starts_ |
| | _Config — understand how environments work_ |
| | _Tests — understand expected behavior_ |

## Who to Ask

| Topic | Person / Channel |
|-------|-----------------|
| Architecture questions | |
| Code review | |
| Access / permissions | |
| General questions | |
`,
    },
    {
      path: "nodes/standards/coding-conventions",
      content: `---
title: Coding Conventions
type: context
tags: [standards, conventions, code-quality]
priority: high
status: published
---

# Coding Conventions

## General Principles

- **Clarity over cleverness** — Write code that the next developer can understand without asking you
- **Consistency over preference** — Follow the existing patterns in the codebase
- **Small, focused changes** — PRs should do one thing well

## Naming

| Element | Convention | Example |
|---------|-----------|---------|
| Variables | _camelCase / snake_case_ | |
| Functions | _camelCase / snake_case_ | |
| Classes | _PascalCase_ | |
| Constants | _UPPER_SNAKE_CASE_ | |
| Files | _kebab-case / snake_case_ | |

## Code Review Standards

### Every PR should:
- [ ] Have a clear description of what and why
- [ ] Include tests for new functionality
- [ ] Pass CI checks
- [ ] Be reviewed by at least one team member

### Reviewers should check:
- Does it do what the description says?
- Are there edge cases not handled?
- Is there unnecessary complexity?
- Are names clear and descriptive?

## Error Handling

_Document your team's error handling patterns here._

## Testing

| Type | When | Coverage Target |
|------|------|----------------|
| Unit | Every PR | _X%_ |
| Integration | Every PR | Key paths |
| E2E | Before release | Critical flows |

## Git Workflow

- Branch naming: \`feature/\`, \`fix/\`, \`chore/\`
- Commit messages: _Conventional commits / free-form / etc._
- Merge strategy: _Squash / rebase / merge commits_
`,
    },
  ],
  packs: [
    {
      id: "engineering-essentials",
      content: `id: engineering-essentials
label: Engineering Essentials
description: Architecture decisions, coding standards, and project knowledge
includes:
  - nodes/architecture/architecture-overview
  - nodes/onboarding/getting-started
  - nodes/standards/coding-conventions
agent_instructions: >
  Use these documents to understand the system architecture, coding standards,
  and development environment. Reference them when answering engineering
  questions or making technical decisions.
`,
    },
  ],
  getPrompt() {
    return getDeveloperPostInitPrompt();
  },
  getMaintenanceDirective() {
    return getDeveloperMaintenanceDirective();
  },
};

// ─── Executive Starter ──────────────────────────────────────────────────────────

const executive: Starter = {
  id: "executive",
  name: "Executive / Leadership",
  description: "Strategy, operations, and leadership vault for C-suite and senior leaders",
  nodes: [
    {
      path: "nodes/strategy/strategic-priorities",
      content: `---
title: Strategic Priorities
type: context
tags: [strategy, priorities, planning]
priority: high
status: draft
---

# Strategic Priorities

## Current Quarter Priorities

1. **[Priority 1 Name]**
   - Objective: _What are we trying to achieve?_
   - Owner: _Who is accountable?_
   - Key Results: _How do we know we've succeeded?_
   - Status: _On track / At risk / Behind_

2. **[Priority 2 Name]**
   - Objective:
   - Owner:
   - Key Results:
   - Status:

3. **[Priority 3 Name]**
   - Objective:
   - Owner:
   - Key Results:
   - Status:

## Strategic Bets

What are we investing in that won't pay off this quarter but matters long-term?

| Bet | Thesis | Time Horizon | Investment Level |
|-----|--------|-------------|-----------------|
| | | | |

## What We're Saying No To

Equally important as priorities — what have we explicitly decided NOT to pursue this quarter, and why?

- _Example: We are not expanding into [market] because [reason]._

## Review Cadence

- Weekly: Status check on Key Results
- Monthly: Priority health review with leadership
- Quarterly: Full strategic review and re-prioritization
`,
    },
    {
      path: "nodes/operations/decision-framework",
      content: `---
title: Decision-Making Framework
type: context
tags: [operations, decisions, framework, governance]
priority: high
status: published
---

# Decision-Making Framework

## Decision Types

| Type | Description | Who Decides | Process |
|------|------------|------------|---------|
| **Reversible** | Low-risk, easily undone | Individual or team lead | Decide and inform |
| **Significant** | Medium-risk, affects multiple teams | Department head | Consult stakeholders, then decide |
| **Strategic** | High-risk, hard to reverse, company-wide impact | Executive team | Structured evaluation (see below) |

## Structured Evaluation (for Strategic Decisions)

### 1. Frame the Decision
- What exactly are we deciding?
- What happens if we do nothing?
- What's the deadline for deciding?

### 2. Gather Input
- Who are the stakeholders?
- What data do we have?
- What data do we wish we had?
- Who has relevant experience?

### 3. Evaluate Options
| Option | Pros | Cons | Risks | Reversibility |
|--------|------|------|-------|--------------|
| A | | | | |
| B | | | | |
| C (do nothing) | | | | |

### 4. Decide and Document
- Decision:
- Rationale:
- What would change our mind:
- Review date:

### 5. Communicate
- Who needs to know?
- What do they need to know?
- By when?

## Principles

- Bias toward action on reversible decisions
- Seek dissent, not consensus, on strategic decisions
- Document the reasoning, not just the outcome
- Set a review date for every strategic decision
`,
    },
    {
      path: "nodes/leadership/alignment-playbook",
      content: `---
title: Stakeholder Alignment Playbook
type: context
tags: [leadership, alignment, communication, stakeholders]
priority: medium
status: published
---

# Stakeholder Alignment Playbook

## Before Any Alignment Conversation

1. **Know your audience** — What do they care about? What are they worried about?
2. **Lead with their frame** — Translate your message into their priorities
3. **Have the data** — One strong data point beats ten opinions
4. **Anticipate objections** — Prepare responses (see template below)

## Alignment Message Template

### For the CEO / Board
**Frame:** Strategic impact and risk
- "Here's what this means for [revenue / market position / competitive advantage]..."
- "The risk of not doing this is..."
- "Here's how we measure success..."

### For Engineering / Product
**Frame:** Doing it right so you don't do it twice
- "Here's the customer problem we're solving..."
- "Here's what success looks like from the user's perspective..."
- "Here's what I need from your team, and by when..."

### For Sales
**Frame:** Revenue impact and credibility
- "Here's how this helps you close deals..."
- "Here's the talk track..."
- "Here's what NOT to promise..."

### For Finance
**Frame:** ROI and resource efficiency
- "Here's the investment required..."
- "Here's the expected return and timeline..."
- "Here's how we'll track spend vs. outcome..."

## Objection Handling Template

| Objection | Response | Supporting Evidence |
|-----------|----------|-------------------|
| "We don't have time for this" | | |
| "We tried this before" | | |
| "This isn't a priority" | | |
| "The ROI isn't clear" | | |

## After the Conversation

- [ ] Send written summary of what was agreed
- [ ] Assign clear owners and deadlines
- [ ] Schedule follow-up if needed
- [ ] Update this playbook with what worked and what didn't
`,
    },
  ],
  packs: [
    {
      id: "strategy-essentials",
      content: `id: strategy-essentials
label: Strategy Essentials
description: Strategic priorities, decision frameworks, and alignment playbooks
includes:
  - nodes/strategy/strategic-priorities
  - nodes/operations/decision-framework
  - nodes/leadership/alignment-playbook
agent_instructions: >
  Use these documents to understand the organization's strategic direction,
  decision-making processes, and stakeholder alignment approaches. Reference
  them when helping with strategic planning, board prep, or leadership
  communications.
`,
    },
  ],
  getPrompt() {
    return getPostInitPrompt(this.id, this.description);
  },
  getMaintenanceDirective() {
    return getDefaultMaintenanceDirective();
  },
};

// ─── Analyst Starter ────────────────────────────────────────────────────────────

const analyst: Starter = {
  id: "analyst",
  name: "Analyst / Research",
  description: "Methodologies, source catalogs, and report templates for research and analysis roles",
  nodes: [
    {
      path: "nodes/methodologies/research-framework",
      content: `---
title: Research Framework
type: context
tags: [methodology, research, framework, analysis]
priority: high
status: published
---

# Research Framework

## Research Process

### 1. Define the Question
- What specifically are we trying to answer?
- Who needs this answer and by when?
- What decisions will this research inform?
- What's the scope and what's out of scope?

### 2. Plan the Approach
- What sources will we use?
- What methods apply (quantitative, qualitative, mixed)?
- What's our confidence threshold?
- What would change our conclusion?

### 3. Collect Data
- Document every source consulted
- Note access date and method
- Assess reliability per source (see source catalog)
- Flag gaps — what couldn't we find?

### 4. Analyze
- Separate facts from interpretations
- Look for corroboration across sources
- Identify contradictions and explain them
- Document alternative explanations

### 5. Report
- Lead with the answer, then the evidence
- State confidence level explicitly
- Acknowledge limitations and gaps
- Provide recommendations if requested

## Quality Criteria

| Criterion | Standard |
|-----------|---------|
| **Accuracy** | All facts verified against at least 2 sources |
| **Completeness** | Key angles covered, gaps explicitly stated |
| **Timeliness** | Data is current as of report date |
| **Objectivity** | Assumptions stated, bias acknowledged |
| **Clarity** | Non-expert can understand the conclusions |

## Confidence Levels

| Level | Meaning | When to Use |
|-------|---------|-------------|
| **High** | Multiple reliable sources corroborate | Strong evidence, low ambiguity |
| **Moderate** | Some corroboration, minor gaps | Reasonable evidence, some assumptions |
| **Low** | Limited sources, significant gaps | Preliminary findings, needs more work |
| **Assessment** | Analyst judgment, limited data | Expert opinion based on experience |
`,
    },
    {
      path: "nodes/reporting/report-template",
      content: `---
title: Report Template
type: context
tags: [reporting, template, deliverable]
priority: medium
status: published
---

# Report Template

## [Report Title]

**Date:** YYYY-MM-DD
**Author:**
**Classification:** _Internal / Confidential / Public_
**Confidence Level:** _High / Moderate / Low_

---

### Executive Summary

_2-3 sentences: What did we find? What does it mean? What do we recommend?_

### Background

_Why was this research conducted? What question were we answering?_

### Methodology

_How did we conduct this research? What sources did we use? What was in/out of scope?_

### Findings

#### Finding 1: [Title]
- **Evidence:**
- **Sources:**
- **Confidence:**

#### Finding 2: [Title]
- **Evidence:**
- **Sources:**
- **Confidence:**

### Analysis

_What do the findings mean? What patterns or connections are significant?_

### Limitations

_What couldn't we determine? What data was unavailable? What assumptions did we make?_

### Recommendations

1.
2.
3.

### Appendix

_Supporting data, source list, methodology details_

---

## Pre-Submission Checklist

- [ ] Executive summary accurately reflects findings
- [ ] All facts are sourced
- [ ] Confidence levels stated for each finding
- [ ] Limitations acknowledged
- [ ] Reviewed by a second analyst
- [ ] Formatting meets organizational standards
`,
    },
    {
      path: "nodes/sources/source-catalog",
      content: `---
title: Source Catalog
type: context
tags: [sources, data, catalog, reliability]
priority: high
status: draft
---

# Source Catalog

## How to Use This Catalog

Document every data source your team uses. Rate reliability. Keep access procedures current. New team members should be able to find and use any source from this document alone.

## Source Template

### [Source Name]
- **Type:** _Database / API / Public record / Subscription / Internal_
- **URL / Access:** _How to access it_
- **Reliability:** _High / Medium / Low_
- **Coverage:** _What it covers and what it doesn't_
- **Update frequency:** _Real-time / Daily / Weekly / Static_
- **Cost:** _Free / Subscription ($X/mo) / Per-query_
- **Notes:** _Quirks, limitations, tips for effective use_

---

## Sources by Category

### Category 1: _[Your Category]_

| Source | Type | Reliability | Access |
|--------|------|------------|--------|
| | | | |

### Category 2: _[Your Category]_

| Source | Type | Reliability | Access |
|--------|------|------------|--------|
| | | | |

## Reliability Assessment Criteria

| Rating | Meaning |
|--------|---------|
| **High** | Primary source, verified data, consistent track record |
| **Medium** | Secondary source, generally reliable, occasional errors |
| **Low** | Unverified, crowdsourced, or known to have gaps |
`,
    },
  ],
  packs: [
    {
      id: "research-essentials",
      content: `id: research-essentials
label: Research Essentials
description: Research methodologies, source catalogs, and report templates
includes:
  - nodes/methodologies/research-framework
  - nodes/reporting/report-template
  - nodes/sources/source-catalog
agent_instructions: >
  Use these documents for research and analysis work. Follow the research
  framework methodology, track source reliability using the catalog, and
  use the report template for deliverables. Cite sources and note
  confidence levels.
`,
    },
  ],
  getPrompt() {
    return getPostInitPrompt(this.id, this.description);
  },
  getMaintenanceDirective() {
    return getDefaultMaintenanceDirective();
  },
};

// ─── Team Starter ───────────────────────────────────────────────────────────────

const team: Starter = {
  id: "team",
  name: "Team / Organization",
  description: "Shared processes, team handbook, and onboarding guides for any team",
  nodes: [
    {
      path: "nodes/processes/how-we-work",
      content: `---
title: How We Work
type: context
tags: [processes, team, norms, rituals]
priority: high
status: draft
---

# How We Work

## Communication

| Channel | Use For | Response Time |
|---------|---------|--------------|
| _Slack / Teams_ | Quick questions, updates, informal discussion | Same day |
| _Email_ | External communication, formal requests | 24 hours |
| _Video call_ | Complex discussions, decisions, 1:1s | Scheduled |
| _This vault_ | Persistent knowledge, processes, decisions | As needed |

## Meetings

| Meeting | Frequency | Duration | Purpose | Attendees |
|---------|-----------|----------|---------|-----------|
| Standup | | | Status, blockers | |
| Team sync | | | Planning, alignment | |
| 1:1 | | | Feedback, growth | |
| Retrospective | | | Process improvement | |

## Decision-Making

- **Day-to-day decisions:** The person closest to the work decides and informs the team
- **Team-level decisions:** Discuss in team sync, team lead makes the call
- **Cross-team decisions:** Escalate to leadership with a recommendation

## Work Hours & Availability

- Core hours: _[time] to [time] [timezone]_
- Flexibility: _[your policy]_
- Time off: _[how to request, how to communicate]_

## Tools

| Tool | What We Use It For |
|------|-------------------|
| | |
| | |
| | |
`,
    },
    {
      path: "nodes/onboarding/first-30-days",
      content: `---
title: First 30 Days
type: context
tags: [onboarding, new-hire, checklist]
priority: high
status: published
---

# First 30 Days

## Day 1: Get Set Up

- [ ] Laptop / equipment ready
- [ ] Accounts created (email, Slack/Teams, tools)
- [ ] Added to relevant channels and groups
- [ ] Meet your manager — expectations conversation
- [ ] Meet 2-3 teammates informally
- [ ] Read this vault — start with "How We Work" and "Team FAQ"

## Week 1: Learn the Landscape

- [ ] Complete all tool/system access requests
- [ ] Shadow a teammate on a typical workflow
- [ ] Read through team processes documentation
- [ ] Attend your first team standup / sync
- [ ] Ask 5 questions and write down the answers (contribute to the FAQ!)
- [ ] Complete your first small task with guidance

## Week 2: Start Contributing

- [ ] Take on a real (small-scope) task independently
- [ ] Get your first work reviewed
- [ ] Meet with stakeholders from adjacent teams
- [ ] Identify one process or doc that confused you — suggest an improvement
- [ ] 1:1 with manager: How's it going? What's unclear?

## Week 3-4: Build Momentum

- [ ] Own a full task or small project end-to-end
- [ ] Contribute to a team discussion or decision
- [ ] Update or create a document in this vault based on what you've learned
- [ ] 1:1 with manager: 30-day check-in — feedback both ways

## By Day 30, You Should:

- [ ] Know what the team does and how your role fits
- [ ] Be able to complete standard tasks independently
- [ ] Know who to ask for help on different topics
- [ ] Have contributed something back to team knowledge (FAQ, process doc, etc.)
- [ ] Feel like part of the team

## Your Onboarding Buddy

**Name:** _[Assigned buddy]_
**Role:** _Your go-to for questions, context, and "how things really work around here"_
`,
    },
    {
      path: "nodes/knowledge/team-faq",
      content: `---
title: Team FAQ
type: context
tags: [knowledge, faq, team, questions]
priority: medium
status: draft
---

# Team FAQ

_The questions everyone asks. Keep this updated — when a new hire asks something not here, add it._

## General

**Q: What does this team do?**
A: _[One paragraph description of the team's mission and scope]_

**Q: Who's on the team?**
A: _[Team roster with roles — or link to org chart]_

**Q: How do I get help if I'm stuck?**
A: _[Describe your escalation path — ask in Slack, ping team lead, etc.]_

## Tools & Access

**Q: What tools do I need access to?**
A: _[List of tools and how to get access]_

**Q: How do I get credentials / permissions for [system]?**
A: _[Who to ask, what process to follow]_

## Processes

**Q: How do I submit my work for review?**
A: _[Your review/approval process]_

**Q: What's the process for [common workflow]?**
A: _[Description or link to process doc]_

**Q: How do I request time off?**
A: _[Process and where to submit]_

## Culture

**Q: What are the team's values?**
A: _[List them — keep it real, not corporate-speak]_

**Q: How do we handle disagreements?**
A: _[Your norms for healthy conflict]_

**Q: How do we celebrate wins?**
A: _[Your rituals — shoutouts, team events, etc.]_

---

_Don't see your question? Ask in [channel] and we'll add the answer here._
`,
    },
  ],
  packs: [
    {
      id: "team-essentials",
      content: `id: team-essentials
label: Team Essentials
description: Team processes, onboarding, and shared knowledge
includes:
  - nodes/processes/how-we-work
  - nodes/onboarding/first-30-days
  - nodes/knowledge/team-faq
agent_instructions: >
  Use these documents to understand team processes, help onboard new
  members, and reference operational procedures. Keep information current
  and flag stale content when noticed.
`,
    },
  ],
  getPrompt() {
    return getPostInitPrompt(this.id, this.description);
  },
  getMaintenanceDirective() {
    return getDefaultMaintenanceDirective();
  },
};

// ─── Sales Starter ─────────────────────────────────────────────────────────────

const sales: Starter = {
  id: "sales",
  name: "Sales / Revenue",
  description: "Objection handling, competitive intelligence, and enablement for sales teams",
  nodes: [
    {
      path: "nodes/playbooks/objection-handling",
      content: `---
title: Objection Handling Playbook
type: context
tags: [playbook, objections, sales, responses]
priority: high
status: draft
---

# Objection Handling Playbook

## How to Use This

When you hear an objection on a call, search this document or ask your AI to pull the relevant response. Update it after every deal — what worked, what didn't.

## Pricing Objections

### "It's too expensive"
**What they're really saying:** _They don't see enough value yet, or they're comparing to a cheaper alternative._
- **Say:** _"I understand. Let me ask — what would it be worth to your team if [specific outcome]? Our customers typically see [specific result] within [timeframe]."_
- **Don't say:** _Don't immediately offer a discount. That signals the price was wrong._
- **Follow-up:** _Ask what they're comparing to. Reframe around ROI, not cost._

### "We don't have budget"
**What they're really saying:** _It's not a priority, or budget is allocated elsewhere._
- **Say:** _"When does your next budget cycle start? Let's plan for that. In the meantime, here's what you could do with our free tier to build the case."_
- **Don't say:** _Don't push for this quarter if the money isn't there._

## Timing Objections

### "Not right now"
- **Say:** _"Totally fair. What would need to change for this to become a priority?"_
- **Follow-up:** _Set a specific follow-up date. "Can I check back in on [date]?"_

### "We just signed with [competitor]"
- **Say:** _"Got it. How long is that contract? I'd love to show you what we're building so you have options when it's up."_

## Competition Objections

### "We're looking at [Competitor X]"
- **Say:** _"Great — they're a solid option for [what competitor is good at]. Where we differ is [your differentiation]. Would it be helpful to see a side-by-side?"_
- **Don't say:** _Never trash the competitor. It makes you look insecure._

## Trust Objections

### "We've never heard of you"
- **Say:** _"That's fair — we're focused on [your market]. Here are a few customers similar to you: [examples]. Would a reference call be helpful?"_

### "How do we know you'll be around in a year?"
- **Say:** _"Good question. Here's our growth trajectory: [metrics]. And here's what we're investing in: [roadmap highlights]."_

---

## Template for New Objections

### "[The objection]"
**What they're really saying:**
- **Say:**
- **Don't say:**
- **Follow-up:**
- **Success rate:** _X/Y times this response worked_
`,
    },
    {
      path: "nodes/competitive/battlecard-template",
      content: `---
title: Competitive Battlecard Template
type: context
tags: [competitive, battlecard, positioning]
priority: high
status: draft
---

# Competitive Battlecard: [Competitor Name]

## Quick Facts

| | Us | Them |
|---|---|---|
| **Founded** | | |
| **Funding / Size** | | |
| **Target Market** | | |
| **Pricing** | | |
| **Key Customers** | | |

## Where We Win

| Dimension | Our Advantage | How to Demo It |
|-----------|-------------|---------------|
| | | |
| | | |
| | | |

## Where They Win

| Dimension | Their Advantage | How to Counter |
|-----------|----------------|---------------|
| | | |
| | | |

## Head-to-Head Feature Comparison

| Feature | Us | Them | Notes |
|---------|---|------|-------|
| | | | |
| | | | |
| | | | |

## Talk Track

**When the prospect mentions [Competitor]:**

> "[Your response — acknowledge them, pivot to your differentiation]"

**When the prospect asks for a direct comparison:**

> "[Your response — focus on what matters to THIS buyer, not a generic feature list]"

## Landmines to Plant

_Questions to ask early that expose the competitor's weaknesses:_
1. "Have you asked them about [weakness area]?"
2. "What's their approach to [area where you're strong]?"

## Win/Loss Notes

| Date | Deal | Outcome | Why |
|------|------|---------|-----|
| | | Won / Lost | |
| | | Won / Lost | |
`,
    },
    {
      path: "nodes/enablement/product-knowledge",
      content: `---
title: Product Knowledge Guide
type: context
tags: [enablement, product, knowledge, features]
priority: high
status: draft
---

# Product Knowledge Guide

## What We Sell (One Sentence)

_[Your product] helps [target customer] to [outcome] by [how]._

## Key Value Propositions

1. **[Value Prop 1]** — _Why it matters to the buyer_
2. **[Value Prop 2]** — _Why it matters to the buyer_
3. **[Value Prop 3]** — _Why it matters to the buyer_

## Feature-to-Benefit Map

| Feature | What It Does | Why the Buyer Cares | Best For |
|---------|-------------|-------------------|----------|
| | | | |
| | | | |
| | | | |

## Pricing

| Tier | Price | Includes | Best For |
|------|-------|---------|----------|
| | | | |
| | | | |
| | | | |

## Ideal Customer Profile

- **Industry:**
- **Company size:**
- **Role of buyer:**
- **Pain they're feeling:**
- **Trigger events:**

## Discovery Questions

1. _"How are you handling [problem] today?"_
2. _"What does that cost you in [time / money / risk]?"_
3. _"What would it look like if this was solved?"_
4. _"Who else is involved in this decision?"_
5. _"What's your timeline for making a change?"_

## Common Use Cases

### Use Case 1: [Name]
- **Scenario:**
- **How we solve it:**
- **Result:**

### Use Case 2: [Name]
- **Scenario:**
- **How we solve it:**
- **Result:**
`,
    },
  ],
  packs: [
    {
      id: "sales-essentials",
      content: `id: sales-essentials
label: Sales Essentials
description: Objection handling, competitive battlecards, and product knowledge
includes:
  - nodes/playbooks/objection-handling
  - nodes/competitive/battlecard-template
  - nodes/enablement/product-knowledge
agent_instructions: >
  Use these documents for sales enablement. Reference the objection handling
  playbook during call prep, use battlecards for competitive situations, and
  pull from product knowledge for demos and discovery calls. Keep content
  practical and action-oriented.
`,
    },
  ],
  getPrompt() {
    return getPostInitPrompt(this.id, this.description);
  },
  getMaintenanceDirective() {
    return getDefaultMaintenanceDirective();
  },
};

// ─── Personal Starter ──────────────────────────────────────────────────────────

const personal: Starter = {
  id: "personal",
  name: "Personal / Second Brain",
  description: "A general-purpose second brain for ideas, decisions, learning, and reference material — no codebase required",
  nodes: [],
  packs: [],
  getPrompt() {
    return getPersonalPostInitPrompt();
  },
  getMaintenanceDirective() {
    return getPersonalMaintenanceDirective();
  },
};

// ─── Registry ───────────────────────────────────────────────────────────────────

export const starters = new Map<string, Starter>([
  ["developer", developer],
  ["personal", personal],
  ["executive", executive],
  ["analyst", analyst],
  ["team", team],
  ["sales", sales],
]);

export function getStarter(id: string): Starter | undefined {
  return starters.get(id);
}

export function listStarters(): Starter[] {
  return Array.from(starters.values());
}
