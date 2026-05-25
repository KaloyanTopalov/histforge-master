# When to Mock

Mock at **system boundaries** only:

- External APIs (payment, email, etc.)
- Databases (sometimes - prefer test DB)
- Time/randomness
- File system (sometimes)

Don't mock:

- Your own classes/modules
- Internal collaborators
- Anything you control
- **UI components from your design system or component library** (Dialog, Modal, ScrollArea, etc.)

## The Import-Path Test

A quick mechanical check for every mock: look at the import path.
- **npm package** (`lodash`, `@supabase/supabase-js`, `next/navigation`) → lives in `node_modules`, can be a legitimate boundary.
- **Project file** (`@/lib/...`, `./utils/...`, `~/services/...`) → internal code you own. Don't mock it.

### Mock the npm package, not your wrapper

Your project has a database client wrapper:

```typescript
// lib/db/client.ts (project file)
import { createClient } from 'awesome-db-sdk';  // npm package
export const db = createClient(process.env.DB_URL);
```

```typescript
// BAD: Mocking the project wrapper — skips your connection setup, config, error handling
vi.mock('@/lib/db/client', () => ({
  db: { query: vi.fn(), insert: vi.fn() },
}));

// GOOD: Mocking the npm package — your wrapper runs for real
vi.mock('awesome-db-sdk', () => ({
  createClient: vi.fn(() => ({
    query: vi.fn(),
    insert: vi.fn(),
  })),
}));
```

The same principle applies to auth wrappers, API client factories, provider modules — anything that creates or configures an external dependency. Mock what it *uses*, not the wrapper itself.

### Use dependency injection when available

If a function accepts dependencies as parameters, pass test doubles directly — no mocking framework needed at all.

```typescript
async function fetchAndProcess(items: Item[], embedder: EmbeddingProvider) {
  const embeddings = await embedder.embed(items);
  return process(embeddings);
}

// No vi.mock needed — pass a fake directly
test('processes embeddings', async () => {
  const fakeEmbedder = {
    embed: async (items) => items.map(() => [0.1, 0.2, 0.3]),
  };
  const result = await fetchAndProcess(items, fakeEmbedder);
  expect(result).toEqual(expected);
});
```

DI is the cleanest approach because there's no mock to leak or reset between tests.

## React/UI Component Testing

A common mistake: mocking internal UI primitives like `Dialog`, `ScrollArea`, or `Button` from your own `components/ui/` directory. These are internal collaborators, not system boundaries — even if they live in a shared library folder.

```typescript
// BAD: Mocking your own UI components
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }) => <div>{children}</div>,
  DialogContent: ({ children }) => <div>{children}</div>,
}));

// GOOD: Render the real components, test through user interaction
test("clicking badge opens source dialog", async () => {
  render(<CitationBadge sourceNumber={1} source={mockSource} />);
  await userEvent.click(screen.getByRole("button"));
  expect(screen.getByText(mockSource.title)).toBeVisible();
});
```

The reason this matters: when you mock a Dialog, your test no longer verifies that the dialog actually opens, renders content, or closes. You're testing your mock, not your component. If the Dialog API changes or you switch UI libraries, the mock keeps passing while the real component breaks.

**What counts as a system boundary in UI testing:**
- Network requests (`fetch`, API clients) — mock these
- Browser APIs not available in test environment (`IntersectionObserver`, `ResizeObserver`) — mock these
- External services (auth providers, analytics) — mock these

**What does NOT count:**
- Your own components (`components/ui/*`, `components/chat/*`) — render them
- Utility functions you wrote — call them
- State management you control — use it

**"But it uses browser APIs not available in jsdom"** — Your project's Dialog or Menu component may wrap an npm library that uses portals or positioning. Try rendering it real first — most work fine in jsdom with testing-library. If it truly fails, mock the *npm package* (e.g., `@radix-ui/react-dialog`), not your `@/components/ui/dialog` wrapper.

## Designing for Mockability

At system boundaries, design interfaces that are easy to mock:

**1. Use dependency injection**

Pass external dependencies in rather than creating them internally:

```typescript
// Easy to mock
function processPayment(order, paymentClient) {
  return paymentClient.charge(order.total);
}

// Hard to mock
function processPayment(order) {
  const client = new StripeClient(process.env.STRIPE_KEY);
  return client.charge(order.total);
}
```

**2. Prefer SDK-style interfaces over generic fetchers**

Create specific functions for each external operation instead of one generic function with conditional logic:

```typescript
// GOOD: Each function is independently mockable
const api = {
  getUser: (id) => fetch(`/users/${id}`),
  getOrders: (userId) => fetch(`/users/${userId}/orders`),
  createOrder: (data) => fetch('/orders', { method: 'POST', body: data }),
};

// BAD: Mocking requires conditional logic inside the mock
const api = {
  fetch: (endpoint, options) => fetch(endpoint, options),
};
```

The SDK approach means:
- Each mock returns one specific shape
- No conditional logic in test setup
- Easier to see which endpoints a test exercises
- Type safety per endpoint
