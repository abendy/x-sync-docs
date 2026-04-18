# GOAP-Based Enrichment Planner

Raw brainstorm from planning session.

---

## The Problem Space

You've built the assessment layer (know what you have vs want) but need the planning layer (decide what to do about it). The decisions involve:

1. What needs enrichment? (stub → partial → complete)
2. When to enrich? (rate limits, session timing)
3. How to enrich? (which source, given risk tolerance)
4. Priority? (which records matter most)

## Patterns & Technologies

### 1. State Machines (XState)

Model each record's lifecycle:
```
stub → [enrich] → partial → [enrich] → complete
        ↑                      ↑
    (rate limit)           (rate limit)
        ↓                      ↓
    waiting               waiting
```
- Guards prevent transitions when rate limited
- Actions trigger the right source
- Visualizable, testable

### 2. Rule Engines (json-rules-engine)

Decouple decision logic:
```json
{
  "conditions": {
    "all": [
      { "fact": "completeness", "operator": "equal", "value": "stub" },
      { "fact": "rateLimit", "operator": "equal", "value": "available" },
      { "fact": "riskTolerance", "operator": "greaterThanInclusive", "value": "moderate" }
    ]
  },
  "event": { "type": "enrich", "params": { "source": "bird" } }
}
```
- Add/modify rules without code changes
- Explain why decisions were made

### 3. Goal-Oriented Action Planning (GOAP)

From game AI - define goal state, let planner find path:
```
Goal: { completeness: 'complete' }
Actions:
- fetchViaApi: { pre: rateAvailable, effect: +completeness, cost: 15min }
- fetchViaBird: { pre: birdAvailable, effect: +completeness, cost: 1sec, risk: moderate }
Planner finds optimal sequence given constraints.
```

### 4. Workflow Engines (Temporal, Inngest)

For durable, long-running enrichment:
- Survives restarts
- Handles rate limit waits elegantly
- Scheduled enrichment jobs
- Progress tracking built-in

### 5. Priority Queues with Scoring

Simpler but effective:
```
score(record) =
  (importance × 10) +           // user-starred, recent
  (completenessGap × 5) +       // stub=10, partial=5
  (enrichmentLikelihood × 3)    // has author_id = can fetch
```
Process highest scores first within rate limits.

## Comparison

| Approach        | Complexity | Fits When                              |
|-----------------|------------|----------------------------------------|
| Priority Queue  | Low        | Simple "process what needs it"         |
| Decision Table  | Low        | Few sources, clear rules               |
| Rule Engine     | Medium     | Rules change often, need explainability|
| State Machine   | Medium     | Complex record lifecycles              |
| GOAP            | High       | Many sources, optimization matters     |
| Workflow Engine | High       | Long-running, durable, distributed     |

## Layered Recommendation

For CLI tool:

```
┌─────────────────────────────────────┐
│  Enrichment Planner                 │  ← Decides what/when/how
│  (Rule Engine or Decision Table)    │
├─────────────────────────────────────┤
│  Source Selector                    │  ← Picks source given constraints
│  (Risk tolerance + availability)    │
├─────────────────────────────────────┤
│  Rate Limit Scheduler               │  ← Queues work within limits
│  (Priority queue + timing)          │
├─────────────────────────────────────┤
│  DataSource Abstraction             │  ← Executes (already built)
└─────────────────────────────────────┘
```

---

## GOAP-Centered Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         GOAP Planner                            │
│  • Receives goals (e.g., "all records complete")                │
│  • Reads world state from Blackboard                            │
│  • Generates optimal action sequence                            │
│  • Re-plans when world state changes                            │
└─────────────────────────────────────────────────────────────────┘
                            │
            ┌───────────────┼───────────────┐
            ▼               ▼               ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│  World State    │ │  Action Library │ │  Goal Registry  │
│  (Blackboard)   │ │                 │ │                 │
└─────────────────┘ └─────────────────┘ └─────────────────┘
        ▲                    │
        │                    ▼
┌─────────────────┐ ┌─────────────────────────────────────┐
│    Sensors      │ │         Plan Executor               │
│  • Rate limits  │ │  • Executes action sequence         │
│  • Completeness │ │  • Handles failures / replanning    │
│  • Availability │ │  • Emits events                     │
└─────────────────┘ └─────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                      DataSource Layer                           │
│                 (Already built - ADR 007)                       │
└─────────────────────────────────────────────────────────────────┘
```

### 1. Blackboard (Shared World State)

Central knowledge store all components read/write:

```typescript
interface WorldState {
  // Record state
  records: {
    total: number;
    complete: number;
    partial: number;
    stub: number;
  };

  // Source state
  sources: {
    [name: string]: {
      available: boolean;
      rateLimit: { remaining: number; resetsAt: Date };
      risk: RiskLevel;
    };
  };

  // User preferences
  preferences: {
    riskTolerance: RiskLevel;
    maxWaitTime: number;
    priorityField?: string; // e.g., "bookmarked_at"
  };

  // Session state
  session: {
    enrichedThisSession: number;
    errorsThisSession: number;
    startedAt: Date;
  };
}
```

### 2. Actions (with Preconditions & Effects)

```typescript
interface GOAPAction {
  name: string;
  cost: (state: WorldState) => number;  // Dynamic cost
  preconditions: (state: WorldState) => boolean;
  effects: Partial<WorldState>;  // What changes
  execute: () => Promise<ActionResult>;
}

// Example actions:
const actions: GOAPAction[] = [
  {
    name: 'enrichViaXApi',
    cost: (state) => state.sources['x-api-free'].rateLimit.remaining > 0 ? 1 : 900,
    preconditions: (state) =>
      state.records.stub > 0 &&
      state.sources['x-api-free'].available,
    effects: { records: { stub: -1, complete: +1 } },
    execute: () => xApiSource.fetchTweetDetails(...)
  },
  {
    name: 'enrichViaBird',
    cost: (state) => state.preferences.riskTolerance >= 'moderate' ? 0.5 : 1000,
    preconditions: (state) =>
      state.records.stub > 0 &&
      state.sources['bird']?.available &&
      state.preferences.riskTolerance >= 'moderate',
    effects: { records: { stub: -1, complete: +1 } },
    execute: () => birdSource.fetchTweetDetails(...)
  },
  {
    name: 'wait',
    cost: (state) => /* time until rate limit resets */,
    preconditions: () => true,
    effects: { /* rate limits reset */ },
    execute: () => sleep(...)
  }
];
```

### 3. Goals

```typescript
interface GOAPGoal {
  name: string;
  priority: number;
  isAchieved: (state: WorldState) => boolean;
  getDesiredState: () => Partial<WorldState>;
}

const goals: GOAPGoal[] = [
  {
    name: 'allRecordsComplete',
    priority: 10,
    isAchieved: (state) => state.records.stub === 0 && state.records.partial === 0,
    getDesiredState: () => ({ records: { stub: 0, partial: 0 } })
  },
  {
    name: 'enrichStubsOnly',
    priority: 5,
    isAchieved: (state) => state.records.stub === 0,
    getDesiredState: () => ({ records: { stub: 0 } })
  }
];
```

### 4. Sensors (Update World State)

```typescript
interface Sensor {
  name: string;
  update: (blackboard: Blackboard) => void;
  frequency: 'continuous' | 'onDemand' | number; // ms
}

const sensors: Sensor[] = [
  {
    name: 'completenessSensor',
    frequency: 'onDemand',
    update: (bb) => {
      const summary = summarizeTweetCompleteness(db.getAllTweets());
      bb.set('records', summary);
    }
  },
  {
    name: 'rateLimitSensor',
    frequency: 1000,
    update: (bb) => {
      // Check rate limit headers, update remaining/reset time
    }
  },
  {
    name: 'sourceAvailabilitySensor',
    frequency: 'onDemand',
    update: async (bb) => {
      for (const source of registry.getSources()) {
        bb.set(`sources.${source.name}.available`, await source.isAvailable());
      }
    }
  }
];
```

### 5. Supporting Components

| Component      | Purpose                                     | Tech Options             |
|----------------|---------------------------------------------|--------------------------|
| Event Bus      | Coordinate components, trigger re-planning  | EventEmitter, mitt, RxJS |
| Utility Curves | Score/prioritize when multiple plans valid  | Custom functions         |
| Plan Cache     | Avoid re-planning for same state            | LRU cache                |
| History/Memory | Track attempts, learn from failures         | SQLite table             |
| Scheduler      | Time-based triggers (rate limit reset)      | node-cron, setTimeout    |

### 6. GOAP Planner Algorithm

The planner uses A* search to find optimal action sequence:

```typescript
interface Plan {
  actions: GOAPAction[];
  totalCost: number;
  expectedOutcome: Partial<WorldState>;
}

function plan(
  currentState: WorldState,
  goal: GOAPGoal,
  availableActions: GOAPAction[]
): Plan | null {
  // A* search from currentState to goal.getDesiredState()
  // Cost = sum of action costs
  // Heuristic = distance to goal state
}
```

### Libraries That Could Help

| Library           | Purpose                                           |
|-------------------|---------------------------------------------------|
| goap-js           | Simple GOAP implementation (may need custom)      |
| xstate            | Could model plan execution as state machine       |
| RxJS              | Reactive sensors, event streams                   |
| json-rules-engine | Could define preconditions declaratively          |
| bullmq            | Queue planned actions with rate limiting          |
| keyv              | Simple blackboard persistence                     |

### Proposed Module Structure

```
src/
├── planner/
│   ├── blackboard.ts      # World state store
│   ├── actions/
│   │   ├── types.ts       # GOAPAction interface
│   │   ├── enrich.ts      # Enrichment actions
│   │   └── wait.ts        # Wait/schedule actions
│   ├── goals/
│   │   ├── types.ts       # GOAPGoal interface
│   │   └── completeness.ts
│   ├── sensors/
│   │   ├── types.ts
│   │   ├── completeness.ts
│   │   └── rate-limit.ts
│   ├── planner.ts         # A* GOAP planner
│   ├── executor.ts        # Plan execution
│   └── index.ts
```

---

## Multi-Service Expansion

The GOAP architecture naturally decomposes into:

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Planner   │────▶│   Queue     │────▶│  Executor   │
│   Service   │     │   (Jobs)    │     │   Workers   │
└─────────────┘     └─────────────┘     └─────────────┘
        │                                       │
        └──────────────┬────────────────────────┘
                       ▼
               ┌─────────────┐
               │    State    │
               │   (DB/KV)   │
               └─────────────┘
```

### Workflow Orchestration Platforms

| Platform     | Type              | Strengths                                                    | Best For                 |
|--------------|-------------------|--------------------------------------------------------------|--------------------------|
| Temporal.io  | Self-host / Cloud | Durable execution, built-in retries, rate limiting, long waits | Complex stateful workflows |
| Inngest      | SaaS              | Event-driven, serverless, great DX                           | Event-triggered jobs     |
| Trigger.dev  | SaaS              | Background jobs, retries, schedules                          | Simpler async tasks      |
| Windmill     | Self-host / Cloud | Scripts as workflows, multi-language                         | Polyglot teams           |
| Prefect      | Python            | Data pipelines, observability                                | Python-heavy, data work  |

### Temporal.io Deep Dive

Temporal is probably the best fit for GOAP-style planning:

```typescript
// Define a workflow
async function enrichmentWorkflow(recordIds: string[]) {
  // Durable state - survives crashes
  const state = await getWorldState();

  // Plan (could be GOAP planner)
  const plan = await planEnrichment(state, recordIds);

  for (const action of plan.actions) {
    // Automatic retries, rate limiting
    await executeAction(action, {
      retry: { maximumAttempts: 3 },
      heartbeat: '30s',
    });

    // Can sleep for days if needed (rate limits)
    if (action.requiresWait) {
      await sleep(action.waitDuration); // Durable sleep!
    }
  }
}
```

Why Temporal fits:
- Durable execution (survives restarts)
- Built-in rate limiting
- Long sleeps (wait 15 min for rate limit = trivial)
- Replay/debug any workflow
- TypeScript SDK is excellent

### AI-Assisted Planning

If you want the planner itself to be smarter:

| Tool      | Approach                                          |
|-----------|---------------------------------------------------|
| LangGraph | Graph-based agent workflows, model GOAP as graph  |
| CrewAI    | Multi-agent collaboration                         |
| AutoGen   | Microsoft's multi-agent framework                 |

LangGraph is interesting because you could have an LLM help decide:
- Which records to prioritize
- When to take risks (use Bird)
- Adapt strategy based on patterns

### Other Languages Worth Considering

| Language | Why                                               | Tools                            |
|----------|---------------------------------------------------|----------------------------------|
| Python   | Rich AI/ML ecosystem, Temporal SDK, better GOAP libs | Prefect, Celery, GOAP implementations |
| Go       | Temporal's native language, excellent for services | Temporal, robust concurrency     |
| Elixir   | Built for fault-tolerant distributed systems      | OTP, Broadway                    |

Python has more mature GOAP implementations from the game dev community.

### Hybrid Architecture Options

**Option 1: Keep CLI, Add Temporal**

```
CLI (TypeScript)           Temporal (Cloud/Self-host)
┌─────────────┐           ┌─────────────────────────┐
│ User runs   │──trigger──▶│ Enrichment Workflow    │
│ `enrich`    │           │ - Plans via GOAP        │
│ command     │◀──status──│ - Executes with retries │
└─────────────┘           │ - Handles rate limits   │
                          └─────────────────────────┘
```

**Option 2: Event-Driven with Inngest**

```
CLI / Cron              Inngest
┌──────────┐           ┌─────────────────────────┐
│ Triggers │──event───▶│ "records.need_enrichment"│
│          │           │                         │
│          │◀─webhook──│ Step functions with     │
│          │           │ sleep, retry, fan-out   │
└──────────┘           └─────────────────────────┘
```

**Option 3: Full Service Split**

```
                    ┌─────────────────┐
                    │  Planner API    │ (Python + GOAP)
                    │  /plan          │
                    └────────┬────────┘
                             │
┌──────────────┐    ┌────────▼────────┐    ┌──────────────┐
│  CLI / Web   │───▶│  Message Queue  │───▶│   Workers    │
│              │    │  (Redis/SQS)    │    │  (fetch data)│
└──────────────┘    └─────────────────┘    └──────────────┘
                             │
                    ┌────────▼────────┐
                    │  State Store    │
                    │  (SQLite/Postgres)
                    └─────────────────┘
```

## Recommendation

Given goals:

1. **If staying simple**: Build GOAP in TypeScript, keep it in the CLI
2. **If going durable/robust**: Add Temporal.io - designed for exactly this
3. **If wanting AI-assist**: Consider LangGraph for smarter planning
4. **If going multi-service**: Python backend for planner + TypeScript CLI

**Temporal + TypeScript CLI** is probably the sweet spot:
- Durable workflows that survive crashes
- Built-in rate limiting and retries
- Can sleep for hours/days waiting for rate limits
- Keep existing CLI as the interface
- Free tier available, or self-host
