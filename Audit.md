# TPS-Controller (Dev) — Audit

Scope
- Reviewed files: [`src/main.ts`](/Users/zachtisherman/TishOS%20v0.1/.obsidian/plugins/TPS-Controller%20(Dev)/src/main.ts), [`src/tps-gcm-api.ts`](/Users/zachtisherman/TishOS%20v0.1/.obsidian/plugins/TPS-Controller%20(Dev)/src/tps-gcm-api.ts), [`src/reminder-engine.ts`](/Users/zachtisherman/TishOS%20v0.1/.obsidian/plugins/TPS-Controller%20(Dev)/src/reminder-engine.ts), [`src/services/reminder-engine.ts`](/Users/zachtisherman/TishOS%20v0.1/.obsidian/plugins/TPS-Controller%20(Dev)/src/services/reminder-engine.ts).

Where issues are
- High: Forced reload workflow can be user-visible and destructive. A reload is triggered from runtime checks instead of a scoped recovery path, which can interrupt editing at any moment and make failures hard to diagnose.
- High: Cross-plugin dependency discovery is mostly optimistic with manual fallback IDs and `any` casts, so incompatible or missing contract shapes cause late runtime failures.
- High: Polling/retry loops for state and dependency checks are active even when events already indicate equivalent changes, causing extra work and potential duplicate actions.
- Medium: Reminder scheduling and mutation paths are co-located with orchestration and external call glue, increasing accidental side effects and making sequencing failures hard to isolate.
- Medium: Logging is mostly warning/notice oriented and does not capture normalized call context (`plugin`, `route`, `outcome`, `reason`), so support triage is guess-based.
- Low: Health checks and controller command routing are split across several places and repeat shape assumptions.

User interaction risks
- User sees sporadic whole-app reload behavior when a dependency is missing, slow, or transiently unavailable.
- Commands can appear to work while internal state did not update because background reconciliation and user actions race.
- Subtle errors are often silent; users get a notice without actionable guidance to fix missing configuration.

Improvements
- Replace reload-on-problem with recoverable state machine:
  - Add explicit `dependencyState` (`missing`, `degraded`, `healthy`) and disable only dependent paths on degraded state.
  - Attempt rebind/re-register without window reload.
  - Show actionable status to user and link to next step in settings.
- Centralize plugin API discovery in one resolver module with canonical IDs + capability checks; remove raw fallback chains in call sites.
- Move reconciliation to event-driven hooks and only keep periodic work where truly needed with strict cancellation on unload.
- Replace broad helper mixes with clearer layering:
  - discovery layer
  - route layer
  - reminder executor
  - diagnostics/event logging

How to simplify/centralize
- Introduce a shared `tps-runtime` package consumed by all TPS plugins:
  - typed plugin contract registry
  - standardized contract negotiation
  - structured debug events with request correlation
  - shared scheduler abstraction (intervals, debounce, single-flight)
- Promote controller APIs to versioned interfaces and remove implicit property access from `any` casts.
