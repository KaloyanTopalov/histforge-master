# Chat Streaming API Route: Full Data Flow Trace

## Overview

The chat streaming system spans the full stack: a React client component initiates a POST request via the Vercel AI SDK's `useChat` hook, the Next.js API route at `/api/chat` authenticates the user, performs RAG retrieval, streams an LLM response back, and the client renders tokens incrementally using the Streamdown library.

---

## 1. Client Side: Sending the Request

### Entry Point: `ChatArea` component
**File:** `components/chat/chat-area.tsx`

The `ChatArea` component is the central orchestrator. It is mounted by either:

- **Existing conversation:** `app/(protected)/chat/[id]/page.tsx` — a server component that fetches the conversation's messages from Supabase and passes them as `initialMessages` along with `conversationId`.
- **New conversation:** `app/(protected)/page.tsx` — passes `conversationId={null}` and no initial messages.

### Transport Setup

`ChatArea` creates a `DefaultChatTransport` configured to POST to `/api/chat`:

```ts
const transport = useMemo(
  () => new DefaultChatTransport({ api: "/api/chat" }),
  []
);
```

### The `useChat` Hook

The Vercel AI SDK's `useChat` hook (`@ai-sdk/react`) manages the chat state:

```ts
const { messages, status, error, sendMessage } = useChat({
  id: conversationId,      // ties the hook instance to a specific conversation
  messages: initialMessages,
  transport,
  onFinish: ({ message }) => { /* extract source-url parts */ },
});
```

### User Sends a Message

1. **`ChatInput`** (`components/chat/chat-input.tsx`) captures user text from a `<textarea>`. On Enter (or button click), it calls `onSend(text)`.

2. **`handleSend` in `ChatArea`:**
   - If `conversationId` is null (new chat), it first POSTs to `/api/conversations` to create a conversation row in the database. The conversation gets a fallback title derived from the first message, and an AI-generated title is kicked off in the background (non-blocking).
   - It then updates the browser URL via `window.history.replaceState` (avoids a Next.js remount that would kill the in-flight stream).
   - Finally calls `sendMessage({ text }, { body: { conversationId } })`. The `body` parameter merges `conversationId` into the POST body alongside the `messages` array that the AI SDK automatically includes.

### What the AI SDK Sends

The POST body to `/api/chat` is:
```json
{
  "messages": [ /* UIMessage[] — full conversation history */ ],
  "conversationId": "uuid-of-conversation"
}
```

---

## 2. Server Side: The API Route

**File:** `app/api/chat/route.ts`

### Step 2a: Authentication and Authorization

1. **Create a Supabase server client** using cookie-based auth (`lib/supabase/server.ts`). This uses `@supabase/ssr`'s `createServerClient` with the anon key, reading session cookies from the request.

2. **Verify user identity:** `supabase.auth.getUser()` — returns 401 if no session.

3. **Check active status:** Queries the `profiles` table for `is_active`. Returns 403 if the account is deactivated.

4. **Verify conversation ownership:** Queries the `conversations` table matching both the `conversationId` and the `user_id`. Returns 404 if not found (prevents users from injecting messages into others' conversations).

### Step 2b: Extract User Message

Extracts the last user message from the `messages` array. It filters message `parts` for `type === "text"` entries and joins them into a single `userText` string.

### Step 2c: RAG Retrieval

**Files:** `lib/rag/embed.ts`, `lib/rag/retrieve.ts`

If `userText` is non-empty, `retrieveContext(userText)` runs the RAG pipeline:

1. **Embed the query:** `embedQuery(text)` calls the OpenAI API with model `text-embedding-3-large` to produce a 3072-dimensional vector embedding of the user's query. This always uses OpenAI regardless of the configured LLM provider.

2. **Vector similarity search:** Calls the Supabase RPC function `match_documents` (defined in migration `006_match_documents.sql`), which:
   - Takes the query embedding, a `match_count`, and a `match_threshold` (both from env vars `RAG_MATCH_COUNT` and `RAG_MATCH_THRESHOLD`).
   - Computes cosine similarity as `1 - (embedding <=> query_embedding)` using pgvector's `<=>` (cosine distance) operator.
   - Filters results above the threshold and returns the top N matches sorted by similarity.

3. **Build sources and context:** Each matched document is transformed into a `Source` object with title (built from publication metadata like type, month, year), subtitle (article title), URL, snippet (first 200 chars), source identifier, and full content. The `contextText` is all documents concatenated with `[Source N: title]` headers.

If the query is empty, RAG is skipped and returns empty context/sources.

### Step 2d: System Prompt Assembly

`getSystemPrompt()` reads the `system_prompt` value from the `config` table using the service role client (bypasses RLS). Falls back to a default prompt if not found.

If RAG returned context, it is appended to the system prompt:
```
{system_prompt}

---
Context from knowledge base:

{contextText}
---
```

### Step 2e: Persist User Message

The user message is inserted into the `messages` table via the service role client (bypasses RLS). The conversation's `updated_at` is also bumped.

### Step 2f: Stream the LLM Response

This is the core streaming logic:

```ts
const stream = createUIMessageStream({
  execute: async ({ writer }) => {
    const modelMessages = await convertToModelMessages(messages);
    const result = streamText({
      model: getModel(),
      system: systemWithContext,
      messages: modelMessages,
    });
    writer.merge(result.toUIMessageStream());
    // Write source-url parts after merging the LLM stream
    for (const source of sources) {
      writer.write({ type: "source-url", ... });
    }
  },
});
return createUIMessageStreamResponse({ stream });
```

Breaking this down:

1. **`convertToModelMessages(messages)`** — Converts the UI-format messages (with `parts` arrays) into the provider-agnostic model message format the AI SDK needs.

2. **`getModel()`** (`lib/ai/provider.ts`) — Returns an AI SDK model instance based on `AI_PROVIDER` env var. Supports `openai`, `anthropic`, and `google` providers. Uses `AI_MODEL` and `AI_API_KEY` env vars.

3. **`streamText()`** — Vercel AI SDK function that calls the LLM and returns a streaming result object. It receives:
   - The model instance
   - The system prompt (with RAG context appended)
   - The full message history

4. **`createUIMessageStream`** — Creates a writable stream in the UI message protocol format. Inside the `execute` callback:
   - `writer.merge(result.toUIMessageStream())` pipes the LLM's token-by-token output into the stream.
   - After merging, source metadata is written as `source-url` stream parts, each with a random UUID, the source URL, title, and custom provider metadata (snippet, subtitle, content, source).

5. **`onFinish` callback on `streamText`** — Once the LLM finishes generating, the complete assistant response text is persisted to the `messages` table along with the sources array as JSONB.

6. **`createUIMessageStreamResponse({ stream })`** — Wraps the stream in a standard `Response` with appropriate headers for streaming (likely `Content-Type: text/event-stream` or similar).

---

## 3. Client Side: Consuming the Stream

### The `useChat` Hook Processes the Stream

The AI SDK's `useChat` hook automatically:
- Reads the streaming response
- Incrementally updates `messages` state as new tokens arrive
- Updates `status` from `"submitted"` to `"streaming"` to `"ready"`

### Rendering: `MessageList` Component
**File:** `components/chat/message-list.tsx`

- Iterates over `messages` and renders each with the `Message` / `MessageContent` wrappers from `components/ai-elements/message.tsx`.
- For assistant messages, text content is rendered via `MessageResponse` (which wraps the `Streamdown` component with plugins for CJK, code highlighting, math, and mermaid diagrams). The `isAnimating` prop is true while the last assistant message is still streaming.
- When `status === "submitted"` (request sent but no tokens yet), a `StreamingIndicator` (three pulsing dots) is shown.
- Error states display a red alert banner.

### Source Extraction on Finish

When the stream completes, `useChat`'s `onFinish` callback fires. It:
1. Filters the completed message's `parts` for `type === "source-url"` entries.
2. Maps them into `Source` objects (extracting custom metadata from `providerMetadata`).
3. Stores them in `messageSources` state keyed by message ID.

### Source Display

Each assistant message with sources gets a `SourcesButton` (`components/chat/sources-button.tsx`). Clicking it:
- Sets the sources in the layout context
- Opens the right sidebar
- Tracks which message's sources are shown via `selectedMessageId`

The right sidebar (`components/sidebar/right-sidebar.tsx`) renders the source cards.

---

## 4. Data Persistence Summary

| Event | Table | Client |
|-------|-------|--------|
| New conversation created | `conversations` | anon (via `/api/conversations`) |
| User message sent | `messages` | service role (in `/api/chat`) |
| Conversation timestamp updated | `conversations` | service role (in `/api/chat`) |
| Assistant response completed | `messages` (with sources JSONB) | service role (in `streamText.onFinish`) |
| AI-generated title | `conversations.title` | service role (background, non-blocking) |

---

## 5. Key Files in the Data Flow

| File | Role |
|------|------|
| `components/chat/chat-input.tsx` | Captures user text input |
| `components/chat/chat-area.tsx` | Orchestrates conversation creation, sends messages via `useChat`, handles sources |
| `app/api/chat/route.ts` | The streaming API route: auth, RAG, LLM streaming, persistence |
| `lib/ai/provider.ts` | Multi-provider LLM abstraction (OpenAI/Anthropic/Google) |
| `lib/rag/embed.ts` | Embeds query text via OpenAI `text-embedding-3-large` |
| `lib/rag/retrieve.ts` | pgvector similarity search + source formatting |
| `supabase/migrations/006_match_documents.sql` | PostgreSQL function for cosine similarity search |
| `supabase/migrations/005_documents.sql` | Documents table with vector column |
| `supabase/migrations/002_conversations_messages.sql` | Conversations and messages schema |
| `supabase/migrations/003_config.sql` | Config table (stores system prompt) |
| `lib/supabase/server.ts` | Cookie-based Supabase server client |
| `components/chat/message-list.tsx` | Renders messages with streaming support |
| `components/ai-elements/message.tsx` | Message UI primitives + Streamdown markdown rendering |
| `components/chat/sources-button.tsx` | Opens right sidebar with RAG sources |
| `components/chat/streaming-indicator.tsx` | Pulsing dots shown while waiting for first token |
| `app/(protected)/chat/[id]/page.tsx` | Server component that loads existing conversation data |
| `app/api/conversations/route.ts` | CRUD for conversations (creation triggers AI title gen) |

---

## 6. Sequence Diagram (Textual)

```
User types message in ChatInput
        |
        v
ChatArea.handleSend()
  |-- (if new chat) POST /api/conversations -> creates conversation row
  |-- sendMessage({ text }, { body: { conversationId } })
        |
        v
useChat hook POSTs to /api/chat
  Body: { messages: UIMessage[], conversationId: string }
        |
        v
API Route: POST /api/chat
  1. Auth check (Supabase cookie session)
  2. Active user check (profiles.is_active)
  3. Conversation ownership check
  4. Extract last user message text
  5. RAG pipeline:
     a. embedQuery(userText) -> OpenAI text-embedding-3-large -> 3072-dim vector
     b. match_documents RPC -> pgvector cosine similarity search -> matched docs
     c. Build contextText + Source[] from matched docs
  6. Fetch system prompt from config table
  7. Append RAG context to system prompt
  8. Persist user message to messages table
  9. Update conversation.updated_at
 10. Create UI message stream:
     a. convertToModelMessages(messages) -> provider-agnostic format
     b. streamText({ model, system, messages }) -> LLM streaming call
     c. writer.merge(result.toUIMessageStream()) -> pipe LLM tokens to stream
     d. writer.write(source-url parts) -> append source metadata
     e. onFinish: persist assistant message + sources to messages table
 11. Return createUIMessageStreamResponse({ stream })
        |
        v (streaming response)
useChat hook consumes stream
  - Updates messages[] incrementally (token by token)
  - status: "submitted" -> "streaming" -> "ready"
        |
        v
MessageList renders messages
  - Streamdown renders markdown with animation while streaming
  - StreamingIndicator shown during "submitted" phase
  - onFinish extracts source-url parts -> messageSources state
  - SourcesButton appears on assistant messages with sources
```
