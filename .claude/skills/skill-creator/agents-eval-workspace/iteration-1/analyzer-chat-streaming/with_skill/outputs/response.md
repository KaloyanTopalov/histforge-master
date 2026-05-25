## Analysis: Chat Streaming API Route

### Overview

The `POST /api/chat` route handles streaming AI responses by first authenticating the user, verifying conversation ownership, running a RAG retrieval pipeline against a pgvector-backed knowledge base, assembling a system prompt with retrieved context, and then streaming an LLM response back using the Vercel AI SDK's `createUIMessageStreamResponse`. Both the user message and the completed assistant reply are persisted to the database, with sources attached to the assistant record.

### Entry Points

- `app/api/chat/route.ts:22` - `export async function POST(req: Request)`
- `lib/ai/provider.ts:9` - `getModel()` - resolves the LLM model instance
- `lib/rag/retrieve.ts:64` - `retrieveContext(query)` - RAG pipeline entry
- `lib/rag/embed.ts:11` - `embedQuery(text)` - embedding generation

---

### Core Implementation

#### 1. Session Authentication (`app/api/chat/route.ts:23-41`)

The route creates a server-side Supabase client via `createClient()` from `lib/supabase/server.ts:4`, which uses `@supabase/ssr`'s `createServerClient` bound to the Next.js cookie store. It calls `supabase.auth.getUser()` at line 26 and returns `401` if no user is found.

Following the auth check, it queries the `profiles` table at line 33-37 for the `is_active` column on the authenticated user's row. If `is_active` is false or the profile is absent, the route returns `403 Account deactivated`.

#### 2. Request Parsing and Conversation Ownership Check (`app/api/chat/route.ts:43-56`)

The request body is parsed as JSON at line 43, destructuring `messages` (typed as `UIMessage[]` from the AI SDK) and `conversationId` (a string UUID). The route then queries the `conversations` table at lines 47-52, filtering by both `id = conversationId` AND `user_id = user.id`. This ensures a user cannot submit messages to a conversation they don't own. If no matching row is found, the route returns `404`.

#### 3. User Message Text Extraction (`app/api/chat/route.ts:58-67`)

The last user message is found by filtering `messages` to `role === "user"` and calling `.pop()` (line 58). If there is no user message, `400` is returned (line 60).

The message content is extracted by filtering the message's `.parts` array for items with `type === "text"` at line 65, then joining them into a single string `userText` at line 67. This handles the AI SDK's multi-part message format.

#### 4. RAG Context Retrieval (`app/api/chat/route.ts:70-72`, `lib/rag/retrieve.ts:64-106`, `lib/rag/embed.ts:11-18`)

If `userText.trim()` is non-empty, `retrieveContext(userText)` is called. Otherwise, `contextText` and `sources` are both set to empty.

Inside `retrieveContext` (`lib/rag/retrieve.ts`):

1. **Embedding** (`retrieve.ts:68-77`, `embed.ts:11-18`): `RAG_MATCH_COUNT` and `RAG_MATCH_THRESHOLD` are read from environment variables. `embedQuery(query)` is called, which creates a lazy singleton OpenAI client at `embed.ts:7-9` and calls `openai.embeddings.create` with model `text-embedding-3-large`, returning a 3072-dimensional float array from `response.data[0].embedding`.

2. **Vector Search** (`retrieve.ts:79-88`): The embedding is passed to the Supabase RPC `match_documents` (defined in `supabase/migrations/006_match_documents.sql`). That SQL function computes cosine similarity as `1 - (d.embedding <=> query_embedding)` (the `<=>` operator is pgvector's cosine distance), filters documents above `match_threshold`, and returns up to `match_count` rows ordered by ascending distance.

3. **Source Assembly** (`retrieve.ts:92-103`): Each returned `MatchedDocument` is mapped to a `Source` object. The `title` is built by `buildSourceTitle()` (`retrieve.ts:53-62`), which capitalizes `pub_type` and combines it with a formatted `pub_month` and `pub_year`. The `snippet` is `doc.content.slice(0, 200)`. Full `content` is included.

4. **Context Text Assembly** (`retrieve.ts:101-103`): `contextText` is built by joining each document's content with a labeled prefix: `[Source N: <title>]\n<content>`, separated by double newlines.

#### 5. System Prompt Assembly (`app/api/chat/route.ts:75-78`)

`getSystemPrompt()` (`route.ts:12-20`) queries the `config` table via the service-role client for the row where `key = 'system_prompt'`. If no row exists, a default fallback string is used.

The final `systemWithContext` is assembled at lines 76-78: if `contextText` is non-empty, it is appended to the system prompt with a separator block: `"---\nContext from knowledge base:\n\n{contextText}\n---"`.

#### 6. User Message Persistence (`app/api/chat/route.ts:81-91`)

Before any streaming begins, the user's message is synchronously inserted into the `messages` table via the service-role client at line 81-85, with `role: "user"` and `content: userText`. The conversation's `updated_at` is also updated at lines 88-91.

Both operations use `serviceClient` (the `@supabase/supabase-js` service-role client initialized at `route.ts:7-10`) to bypass RLS.

#### 7. Stream Construction and LLM Call (`app/api/chat/route.ts:93-132`)

A `UIMessageStream` is created via `createUIMessageStream` at line 93. Inside its `execute` callback:

- The AI SDK's `convertToModelMessages(messages)` is called at line 95 to transform the `UIMessage[]` format into the provider-agnostic `ModelMessage[]` format.
- `streamText` is called at line 96 with the resolved model from `getModel()`, the assembled `systemWithContext`, and the converted messages.
- `getModel()` (`lib/ai/provider.ts:9-26`) reads `AI_PROVIDER`, `AI_MODEL`, and `AI_API_KEY` from environment variables and switches on the provider string (`"openai"`, `"anthropic"`, or `"google"`) to create and return the appropriate provider model instance.
- The `onFinish` callback at line 100-108 fires when the LLM completes. It inserts the assistant's full text into `messages` with `role: "assistant"`, and stores the `sources` array as JSONB (or `null` if empty).
- The LLM stream is merged into the UI message stream via `writer.merge(result.toUIMessageStream())` at line 112.
- Each retrieved source is then written as a discrete `source-url` stream part at lines 115-130. Each part has a random UUID `sourceId`, the source's `url`, `title`, and additional metadata (`snippet`, `subtitle`, `content`, `source`) placed in `providerMetadata.custom`.

#### 8. Response (`app/api/chat/route.ts:134`)

`createUIMessageStreamResponse({ stream })` wraps the `UIMessageStream` into a proper HTTP streaming `Response` and is returned directly.

---

### Data Flow

1. `POST /api/chat` arrives at `app/api/chat/route.ts:22`
2. Session validated via cookie-bound Supabase client (`route.ts:23-30`)
3. User `is_active` checked against `profiles` table (`route.ts:33-41`)
4. Request body parsed: `messages`, `conversationId` (`route.ts:43-44`)
5. Conversation ownership verified against `conversations` table (`route.ts:47-56`)
6. Last user message text extracted from `parts[]` (`route.ts:58-67`)
7. `retrieveContext(userText)` called (`route.ts:70-72`)
   - `embedQuery(userText)` -> OpenAI `text-embedding-3-large` -> 3072-dim vector (`embed.ts:11-18`)
   - `match_documents` RPC -> pgvector cosine similarity search -> `MatchedDocument[]` (`retrieve.ts:79-83`)
   - Documents mapped to `Source[]` and `contextText` string (`retrieve.ts:92-103`)
8. System prompt fetched from `config` table (`route.ts:75`)
9. `systemWithContext` assembled with injected context block (`route.ts:76-78`)
10. User message inserted to `messages` table (`route.ts:81-85`)
11. Conversation `updated_at` bumped (`route.ts:88-91`)
12. `createUIMessageStream` opens a stream (`route.ts:93`)
13. `convertToModelMessages` converts `UIMessage[]` to model format (`route.ts:95`)
14. `streamText` initiated with provider model, system prompt, messages (`route.ts:96-109`)
15. LLM token stream merged into UI stream (`route.ts:112`)
16. Source `source-url` parts written into UI stream (`route.ts:115-130`)
17. On LLM completion: assistant message + sources persisted to `messages` table (`route.ts:100-108`)
18. `createUIMessageStreamResponse` returns HTTP streaming response (`route.ts:134`)

---

### Key Patterns

- **Service Role Client for Writes**: All database mutations (message inserts, conversation timestamp update) use the module-level `serviceClient` (`route.ts:7-10`) initialized with `SUPABASE_SERVICE_ROLE_KEY`, bypassing RLS entirely. Auth checks use the cookie-bound `supabase` client, which operates under RLS.
- **Lazy Singleton Clients**: Both `lib/rag/retrieve.ts:4-13` and `lib/rag/embed.ts:3-9` use module-level variables with guard checks to lazily initialize their respective Supabase and OpenAI clients once per process lifetime.
- **Provider Abstraction**: `lib/ai/provider.ts` isolates all LLM SDK imports behind a single `getModel()` factory that switches on the `AI_PROVIDER` environment variable, so the rest of the codebase never imports SDK-specific modules directly.
- **Dual-client Auth Pattern**: The route uses the cookie-bound user-scoped client for identity verification (`supabase.auth.getUser()`, profile check, conversation ownership) and the service-role client for all write operations, giving two distinct permission levels within one request handler.
- **Stream Composition**: The AI SDK's `UIMessageStream` acts as a multiplexer: the LLM token stream is merged in at `route.ts:112` and discrete source metadata objects are written individually at `route.ts:116-129`, so the client receives both content tokens and structured source data over a single HTTP response stream.

---

### Configuration

- `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — used by `serviceClient` at `route.ts:7-10` and `retrieve.ts:7-10`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` — used by `createClient()` in `lib/supabase/server.ts:8-9`
- `AI_PROVIDER`, `AI_MODEL`, `AI_API_KEY` — control LLM selection in `lib/ai/provider.ts:5-7`
- `OPENAI_API_KEY` — used exclusively for embeddings in `lib/rag/embed.ts:7`
- `RAG_MATCH_COUNT`, `RAG_MATCH_THRESHOLD` — control pgvector search parameters in `lib/rag/retrieve.ts:68-69`
