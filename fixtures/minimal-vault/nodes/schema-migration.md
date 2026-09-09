---
title: "Schema Migration Plan"
description: "Approved plan for migrating the persistence schema"
type: document
tags:
  - "#engineering"
  - "#database"
status: approved
version: 1
author: jane.doe@example.com
created_at: 2024-02-10T09:00:00Z
updated_at: 2024-02-20T16:00:00Z
---

# Schema Migration Plan

Approved plan for migrating the persistence schema to the new format.

## Phases

1. Backfill new columns.
2. Dual-write.
3. Cut over reads.
4. Drop legacy columns.
