# RAG Retrieval Process: From Query Embedding to Results

## Overview

The RAG pipeline in this project follows a straightforward four-stage flow: **extract user text** -> **embed query** -> **vector similarity search** -> **inject context into system prompt**. The entire pipeline executes on each chat API request before the LLM generates a response.

---

## Stage 1: User Message Extraction

**File:** `app/api/chat/route.ts` (lines 58-67)

When a POST request arrives at `/api/chat`, the route handler extracts the last user message from the conversation's `messages` array. It filters message parts for `type: "text"` and joins them into a single string (`userText`). If the resulting text is empty (after trimming), RAG retrieval is skipped entirely and both `contextText` and `sources` default to empty.

---

## Stage 2: Query Embedding

**File:** `lib/rag/embed.ts`

The `embedQuery()` function converts the user's text query into a 3072-dimensional vector using OpenAI's `text-embedding-3-large` model. Key details:

- **Model:** `text-embedding-3-large` (always OpenAI, regardless of which LLM provider is configured for chat)
- **Dimensions:** 3072 (matching the `VECTOR(3072)` column in the `documents` table)
- **Client:** A lazily-initialized singleton OpenAI client using `OPENAI_API_KEY`
- **Error handling:** If embedding fails, the function in `retrieve.ts` catches the error, logs it, and returns empty results (the chat continues without RAG context)

---

## Stage 3: Vector Similarity Search

**File:** `lib/rag/retrieve.ts` (the `retrieveContext()` function, lines 64-106)
**Database function:** `supabase/migrations/006_match_documents.sql`

### 3a. RPC Call

The `retrieveContext()` function calls a Supabase RPC function named `match_documents` with three parameters:

| Parameter | Source | Default |
|-----------|--------|---------|
| `query_embedding` | The 3072-dim vector from Stage 2 | -- |
| `match_count` | `RAG_MATCH_COUNT` env var | `5` |
| `match_threshold` | `RAG_MATCH_THRESHOLD` env var | `0.7` |

### 3b. The `match_documents` PostgreSQL Function

Defined in `supabase/migrations/006_match_documents.sql`, this function:

1. Computes **cosine similarity** for each document using the formula `1 - (d.embedding <=> query_embedding)`. The `<=>` operator is pgvector's cosine distance operator.
2. **Filters** out any document whose similarity score is at or below `match_threshold`.
3. **Orders** results by cosine distance ascending (most similar first).
4. **Limits** results to `match_count` rows.

Returns columns: `id` (INT8), `content` (TEXT), `metadata` (JSONB), `similarity` (FLOAT).

### 3c. The `documents` Table

Defined in `supabase/migrations/005_documents.sql`:

- `id`: BIGINT auto-generated identity
- `content`: TEXT (the chunk text)
- `metadata`: JSONB (contains fields like `title`, `url`, `pub_type`, `pub_month`, `pub_year`, `article_title`)
- `embedding`: VECTOR(3072)
- Protected by RLS; only `service_role` has access

The `retrieve.ts` module uses a Supabase client initialized with the **service role key** to bypass RLS.

---

## Stage 4: Result Formatting

**File:** `lib/rag/retrieve.ts` (lines 92-105)

The matched documents are transformed into two outputs:

### Sources Array

Each document becomes a `Source` object:

```
{
  title:    buildSourceTitle(metadata)   // e.g. "Watchtower, March, 2024"
  subtitle: metadata.article_title       // article-level title
  url:      metadata.url
  snippet:  content.slice(0, 200)        // first 200 chars as preview
  source:   metadata.url || metadata.title
  content:  full document content
}
```

The `buildSourceTitle()` helper constructs a human-readable title from `pub_type`, `pub_month`, and `pub_year` metadata fields. Month numbers are converted to names (e.g., 3 -> "March").

### Context Text

A single string concatenating all matched documents in the format:

```
[Source 1: Watchtower, March, 2024]
<full content of document 1>

[Source 2: ...]
<full content of document 2>
```

---

## Stage 5: Context Injection into LLM

**File:** `app/api/chat/route.ts` (lines 74-78, 93-132)

The system prompt (fetched from the `config` table in the database) is augmented with the context text:

```
<system prompt>

---
Context from knowledge base:

<contextText>
---
```

This combined system prompt is passed to `streamText()` from the Vercel AI SDK, which streams the LLM response back to the client.

---

## Stage 6: Source Delivery to Frontend

**File:** `app/api/chat/route.ts` (lines 114-130)

After merging the LLM text stream, the API route writes each source as a `source-url` stream part using the AI SDK's `UIMessageStream` writer. Each source includes its metadata in `providerMetadata.custom`.

### Client-Side Source Handling

**File:** `components/chat/chat-area.tsx` (lines 69-96)

The `useChat` hook's `onFinish` callback extracts `source-url` parts from the completed message, reconstructs the `Source` objects, and stores them in a `messageSources` state map keyed by message ID.

### Persistence

**File:** `app/api/chat/route.ts` (lines 100-107)

When the LLM stream finishes, the assistant message is persisted to the `messages` table with the `sources` JSONB column populated (or null if no sources). On page reload, `app/(protected)/chat/[id]/page.tsx` loads these persisted sources from the database and passes them as `initialSources` to `ChatArea`.

### Display

**File:** `components/sidebar/right-sidebar.tsx`

Sources are rendered in the right sidebar as `SourceCard` components, with visit tracking managed by the layout context.

---

## Key Files

| File | Role |
|------|------|
| `lib/rag/embed.ts` | Query embedding via OpenAI text-embedding-3-large |
| `lib/rag/retrieve.ts` | Orchestrates embedding + RPC call + result formatting |
| `supabase/migrations/005_documents.sql` | Documents table schema (content, metadata, embedding) |
| `supabase/migrations/006_match_documents.sql` | pgvector cosine similarity search function |
| `app/api/chat/route.ts` | Chat API: triggers RAG, injects context, streams response, persists sources |
| `components/chat/chat-area.tsx` | Client-side source extraction from stream |
| `app/(protected)/chat/[id]/page.tsx` | Server-side source hydration from DB on page load |
| `components/sidebar/right-sidebar.tsx` | Source display in right sidebar |
| `lib/ai/provider.ts` | LLM provider abstraction (not RAG-specific, but receives the augmented prompt) |

## Configuration

| Env Variable | Purpose | Default |
|-------------|---------|---------|
| `OPENAI_API_KEY` | Always required for embeddings | -- |
| `RAG_MATCH_COUNT` | Max documents to return | 5 |
| `RAG_MATCH_THRESHOLD` | Minimum cosine similarity | 0.7 |
