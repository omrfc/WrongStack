# Future Architecture & Feature Proposals

This document outlines high-priority improvement proposals to enhance WrongStack's resilience, security, and developer experience.

---

## 1. Robust JSON Parsing for LLM-Generated Outputs

### Problem
In `SecurityScannerOrchestrator` (`orchestrator.ts`), LLM-generated JSON payloads (such as custom security skills or findings arrays) are extracted via regex and parsed using standard `JSON.parse`. LLMs frequently return trailing commas, single-line comments, or unescaped characters which cause `JSON.parse` to crash and silently trigger fallback behaviors.

### Proposal
Integrate the existing `sanitizeJsonString` utility from `@wrongstack/core` (`packages/core/src/utils/safe-json.ts`) before parsing JSON within all LLM orchestrators.

```typescript
import { sanitizeJsonString } from '../utils/safe-json.js';

const jsonMatch = text.match(/\{[\s\S]*\}/);
if (jsonMatch) {
  const sanitized = sanitizeJsonString(jsonMatch[0]!) || jsonMatch[0]!;
  const parsedData = JSON.parse(sanitized);
  // ...
}
```

---

## 2. Retry Policy & Rate-Limit Resilience in Security Scanner

### Problem
The `SecurityScannerOrchestrator` performs direct `provider.complete` calls. If any of these requests trigger a rate limit (HTTP 429) or transient server error (HTTP 5xx), the scan fails or falls back instantly without cooperative retries.

### Proposal
Expose and wire `TOKENS.ErrorHandler` and `TOKENS.RetryPolicy` from the core container into the `SecurityScannerOrchestrator`. Wrapper methods can handle exponential backoff and request retries transparently when transient provider errors occur.

---

## 3. Strict State Isolation for Slash Commands (WebUI Session Safety)

### Problem
Recent refactoring in `packages/cli/src/slash-commands/sdd.ts` moved module-level variables (`activeBuilder`, `activeTaskStore`) to a process-lifetime `SDDState` instance. However, with the WebUI supporting concurrent browser/REPL sessions, other slash commands or modules with module-level `let` states may leak context across concurrent executions.

### Proposal
Perform an audit across all slash-command files. Refactor any module-level mutable variables to bind to session-scoped container providers or store them within the transient `Context` object so that concurrent agent sessions remain completely isolated.

---

## 4. Human-in-the-Loop Risk Profiling for Semi-Autonomous Execution

### Problem
While `--yolo` mode bypasses all permission prompts for high autonomy, running completely unmonitored commands (like recursive deletes or database drop scripts) carries high risk.

### Proposal
Introduce a risk-profiling matrix for registered tools:
- Classify tools into risk tiers: `safe` (e.g. `read`, `glob`), `standard` (e.g. `edit`, `write`), and `destructive` (e.g. destructive `bash` patterns, recursive directory deletions).
- Implement a selective YOLO gate where even in `--yolo` mode, `destructive` patterns prompt a quick re-approval/alert (`tool.confirm_needed`) unless explicitly bypassed with a `--force-all-yolo` policy override.

---

## 5. Scoped EventBus & Leak Prevention for Dynamic Plugins

### Problem
WrongStack fires over 28 typed events. Dynamic plugins or long-lived TUI/WebUI interfaces subscribe to these events extensively. Forgotten listener unsubscriptions during teardown or session-termination can cause silent memory leaks.

### Proposal
Create a `ScopedEventBus` or `EventBusTracker` instance for each dynamic plugin or session context. This tracker records every listener registration and guarantees absolute garbage collection by automatically calling `.off()` on all tracked events during plugin teardown.
