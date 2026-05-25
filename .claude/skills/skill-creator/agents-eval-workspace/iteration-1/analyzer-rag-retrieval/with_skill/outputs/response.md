## Analysis: RAG Retrieval Process

### Overview

When a user sends a chat message, the API route extracts the query text, calls `retrieveContext()` which embeds the query via OpenAI's `text-embedding-3-large` model (3072 dimensions), then runs a pgvector cosine-similarity search against the `documents` table using the `match_documents` Postgres function. The resulting documents are formatted into a `contextText` string that is prepended to the system prompt, and individual source metadata objects are streamed back to the client as `source-url` stream parts.

### Entry Points

- `/app/api/chat/route.ts:70` — RAG is triggered conditionally: `const { contextText, sources } = userText.trim() ? await retrieveContext(userText) : { contextText: "", sources: [] };`
- `/lib/rag/retrieve.ts:64` — `retrieveContext(query: string)` — primary retrieval function
- `/lib/rag/embed.ts:11` — `embedQuery(text: string)` — embedding function

---

### Core Implementation

#### 1. Query Embedding (`/lib/rag/embed.ts:11-18`)

`embedQuery(text)` is called with the raw user message text. It lazily initializes a singleton `OpenAI` client at line 4-9 using `process.env.OPENAI_API_KEY`. It calls `openai.embeddings.create` with model `"text-embedding-3-large"` and the raw query text as `input`. The response at line 17 returns `response.data[0].embedding`, which is a `number[]` of 3072 dimensions.

#### 2. Configuration Read (`/lib/rag/retrieve.ts:68-69`)

At the start of `retrieveContext`, two environment variables are parsed:
- `RAG_MATCH_COUNT` — parsed as integer via `parseInt(..., 10)`, controls how many documents to return
- `RAG_MATCH_THRESHOLD` — parsed as float via `parseFloat(...)`, controls the minimum similarity score

#### 3. Embedding Call with Error Boundary (`/lib/rag/retrieve.ts:71-77`)

`embedQuery(query)` is called inside a `try/catch`. If embedding fails, the function logs the error to `console.error("[RAG] Embedding failed:", err)` and returns `{ contextText: "", sources: [] }` — an empty result that causes the chat to proceed without RAG context.

#### 4. Database Similarity Search (`/lib/rag/retrieve.ts:79-83`)

A singleton Supabase client is created at lines 4-13 using the service role key (`SUPABASE_SERVICE_ROLE_KEY`), bypassing RLS. The RPC call `.rpc("match_documents", { query_embedding, match_count, match_threshold })` invokes the `match_documents` Postgres function defined in `/supabase/migrations/006_match_documents.sql`.

The SQL function at lines 3-28 of that migration:
- Accepts a `VECTOR(3072)` query embedding, an integer `match_count` (default 5), and a float `match_threshold` (default 0.7)
- Computes similarity as `1 - (d.embedding <=> query_embedding)` — the `<=>` operator is pgvector's cosine distance, so subtracting from 1 converts distance to similarity
- Filters rows with `WHERE 1 - (d.embedding <=> query_embedding) > match_threshold`
- Orders results by `d.embedding <=> query_embedding` ascending (closest first)
- Returns at most `match_count` rows with columns: `id`, `content`, `metadata` (JSONB), `similarity` (FLOAT)

The `documents` table (`/supabase/migrations/005_documents.sql:3-8`) stores: `id` (BIGINT), `content` (TEXT), `metadata` (JSONB), and `embedding` (VECTOR(3072)).

#### 5. RPC Error Handling (`/lib/rag/retrieve.ts:85-88`)

If the Supabase RPC returns an error, it is logged as `"[RAG] match_documents RPC error:"` and the function returns `{ contextText: "", sources: [] }`, again allowing the chat to proceed without context.

#### 6. Source Object Construction (`/lib/rag/retrieve.ts:92-99`)

Each `MatchedDocument` (typed at lines 24-37) is mapped to a `Source` object (typed at lines 15-22):
- `title` — built by `buildSourceTitle(doc.metadata)` (see below)
- `subtitle` — `doc.metadata.article_title ?? ""`
- `url` — `doc.metadata.url ?? ""`
- `snippet` — first 200 characters of `doc.content` via `.slice(0, 200)`
- `source` — `doc.metadata.url ?? doc.metadata.title ?? ""`
- `content` — the full `doc.content`

#### 7. Title Construction (`/lib/rag/retrieve.ts:39-62`)

`buildSourceTitle(meta)` assembles a display title from metadata fields:
- `pub_type` — capitalized (first letter upper, rest lower)
- `pub_month` + `pub_year` — combined as `"Month, Year"` or individually if only one is present. Month conversion is done by `formatMonthName()` at lines 44-51, which handles both numeric months (1-12 mapped to `MONTH_NAMES` array) and string month names (normalized to capitalized first letter)
- Parts are joined with `", "`, falling back to `"Untitled"` if no parts exist

#### 8. Context Text Assembly (`/lib/rag/retrieve.ts:101-103`)

The matched documents are joined into a single `contextText` string. Each document is formatted as:
```
[Source N: <title>]
<full content>
```
Documents are separated by `"\n\n"`.

#### 9. System Prompt Injection (`/app/api/chat/route.ts:75-78`)

`getSystemPrompt()` at lines 12-20 fetches the prompt from the `config` table (key `"system_prompt"`), falling back to a hardcoded default. If `contextText` is non-empty, it is appended to the system prompt as:
```
<system_prompt>

---
Context from knowledge base:

<contextText>
---
```
This combined string becomes the `system` parameter passed to `streamText`.

#### 10. Source Streaming to Client (`/app/api/chat/route.ts:115-130`)

After merging the LLM text stream at line 112, each `Source` is written to the UI message stream as a `source-url` stream part with:
- `type: "source-url"`
- `sourceId` — a fresh `crypto.randomUUID()`
- `url` — `source.url || "#"`
- `title` — `source.title`
- `providerMetadata.custom` — contains `snippet`, `subtitle`, `content`, and `source`

#### 11. Source Persistence (`/app/api/chat/route.ts:100-108`)

Inside `streamText`'s `onFinish` callback, the assistant message is persisted to the `messages` table with `sources: sources.length > 0 ? sources : null`, storing the full sources array as a JSONB column.

---

### Data Flow

1. POST request arrives at `/app/api/chat/route.ts:22`
2. Auth and profile checks at lines 23-41
3. Last user message text extracted at lines 58-67
4. `retrieveContext(userText)` called at `/app/api/chat/route.ts:71`
5. `RAG_MATCH_COUNT` and `RAG_MATCH_THRESHOLD` read from env at `/lib/rag/retrieve.ts:68-69`
6. `embedQuery(userText)` called at `/lib/rag/retrieve.ts:73` → `/lib/rag/embed.ts:11`
7. OpenAI `text-embedding-3-large` returns `number[3072]` at `/lib/rag/embed.ts:17`
8. `match_documents` RPC called with embedding + thresholds at `/lib/rag/retrieve.ts:79`
9. Postgres cosine search executes in `match_documents` function (`/supabase/migrations/006_match_documents.sql:17-26`)
10. Results typed as `MatchedDocument[]` at `/lib/rag/retrieve.ts:90`
11. Sources mapped and `contextText` assembled at `/lib/rag/retrieve.ts:92-103`
12. `contextText` injected into system prompt at `/app/api/chat/route.ts:76-78`
13. LLM streams response using augmented system prompt at lines 96-99
14. Source objects written as `source-url` stream parts at lines 115-130
15. Sources persisted to `messages.sources` at lines 102-107

### Key Patterns

- **Lazy Singleton Clients**: Both the OpenAI client (`/lib/rag/embed.ts:3-9`) and Supabase service client (`/lib/rag/retrieve.ts:4-13`) are initialized once and reused across invocations.
- **Graceful Degradation**: Both the embedding step (`/lib/rag/retrieve.ts:71-77`) and the RPC step (`/lib/rag/retrieve.ts:85-88`) return empty results on failure rather than throwing, allowing the chat to continue without RAG context.
- **Service Role Bypass**: The Supabase client in `retrieve.ts` uses `SUPABASE_SERVICE_ROLE_KEY` to bypass RLS on the `documents` table, which is otherwise restricted to `service_role` only (`/supabase/migrations/005_documents.sql:10-17`).
- **Skip on Empty Query**: The RAG call at `/app/api/chat/route.ts:70-72` is skipped entirely when the user message is empty or whitespace-only.

### Configuration

- `OPENAI_API_KEY` — used exclusively for embeddings regardless of the chat LLM provider (`/lib/rag/embed.ts:6`)
- `RAG_MATCH_COUNT` — integer, controls maximum documents returned (`/lib/rag/retrieve.ts:68`)
- `RAG_MATCH_THRESHOLD` — float, minimum cosine similarity to include a document (`/lib/rag/retrieve.ts:69`); the SQL default is `0.7` (`/supabase/migrations/006_match_documents.sql:6`)
- `NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` — used to connect to the Postgres instance for the RPC call (`/lib/rag/retrieve.ts:7-9`)

### Relevant Files

- `/lib/rag/embed.ts` — query embedding via OpenAI
- `/lib/rag/retrieve.ts` — full retrieval pipeline, source mapping, context assembly
- `/app/api/chat/route.ts` — orchestrates RAG within the chat POST handler
- `/supabase/migrations/005_documents.sql` — `documents` table schema with `VECTOR(3072)` column
- `/supabase/migrations/006_match_documents.sql` — `match_documents` Postgres function with cosine similarity logic
