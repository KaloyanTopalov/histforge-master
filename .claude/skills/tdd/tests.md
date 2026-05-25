# Good and Bad Tests

## Good Tests

**Integration-style**: Test through real interfaces, not mocks of internal parts.

```typescript
// GOOD: Tests observable behavior
test("user can checkout with valid cart", async () => {
  const cart = createCart();
  cart.add(product);
  const result = await checkout(cart, paymentMethod);
  expect(result.status).toBe("confirmed");
});
```

Characteristics:

- Tests behavior users/callers care about
- Uses public API only
- Survives internal refactors
- Describes WHAT, not HOW
- One logical assertion per test

## Bad Tests

**Implementation-detail tests**: Coupled to internal structure.

```typescript
// BAD: Tests implementation details
test("checkout calls paymentService.process", async () => {
  const mockPayment = jest.mock(paymentService);
  await checkout(cart, payment);
  expect(mockPayment.process).toHaveBeenCalledWith(cart.total);
});
```

Red flags:

- Mocking internal collaborators
- Testing private methods
- Asserting on call counts/order
- Test breaks when refactoring without behavior change
- Test name describes HOW not WHAT
- Verifying through external means instead of interface

```typescript
// BAD: Bypasses interface to verify
test("createUser saves to database", async () => {
  await createUser({ name: "Alice" });
  const row = await db.query("SELECT * FROM users WHERE name = ?", ["Alice"]);
  expect(row).toBeDefined();
});

// GOOD: Verifies through interface
test("createUser makes user retrievable", async () => {
  const user = await createUser({ name: "Alice" });
  const retrieved = await getUser(user.id);
  expect(retrieved.name).toBe("Alice");
});
```

## Testing Through Real Internal Code

The most valuable tests exercise the full chain of internal modules, mocking only at the npm boundary. This tests real behavior, not imaginary wiring.

```typescript
// Your auth flow: route → requireAuth() → createClient() → @supabase/ssr
// Three project files, one npm boundary at the bottom.

// GOOD: Mock only the npm package — the entire auth chain runs for real
vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => ({
    auth: {
      getUser: vi.fn(() => ({
        data: { user: { id: 'u1', email: 'test@example.com' } },
      })),
    },
    from: vi.fn(() => chain()),
  })),
}));

test('authenticated user gets their data', async () => {
  // This single call exercises: route handler → requireAuth → createClient → mock
  const response = await GET();
  expect(response.status).toBe(200);
});
```

```typescript
// BAD: Mock every internal layer — tests nothing but your mocks
vi.mock('@/lib/db/client', () => ({ createClient: vi.fn() }));
vi.mock('@/lib/auth/guards', () => ({ requireAuth: vi.fn(() => ({ id: 'u1' })) }));
vi.mock('@/lib/auth/whitelist', () => ({ isAllowed: vi.fn(() => true) }));

test('authenticated user gets their data', async () => {
  // All three internal modules are fake — if any of them break, this test still passes
  const response = await GET();
  expect(response.status).toBe(200);
});
```

When you mock at the npm boundary, every internal function in the chain executes. If someone refactors the auth guards, the test still works. If someone *breaks* the auth guards, the test catches it.
