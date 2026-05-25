# RAG Pipeline Files — Complete Inventory

## Summary

The RAG (Retrieval-Augmented Generation) pipeline in this project spans **16 files** across 5 layers: core RAG logic, database schema, API routes, UI components for displaying sources, and configuration/documentation. Below is the complete list organized by layer, with descriptions of each file's role in the pipeline.

---

## 1. Core RAG Library (`lib/rag/`)

These are the two dedicated RAG modules that handle embedding and retrieval.

### `C:\Users\alexa\Desktop\jw-assistant\lib\rag\embed.ts`
- **Role**: Query embedding
- Initializes a singleton OpenAI client using `OPENAI_API_KEY`
- Exports `embedQuery(text)` which calls OpenAI's `text-embedding-3-large` model (3072 dimensions) and returns the embedding vector
- Always uses OpenAI regardless of the configured LLM provider

### `C:\Users\alexa\Desktop\jw-assistant\lib\rag\retrieve.ts`
- **Role**: Vector similarity search and source formatting
- Creates a Supabase service-role client for privileged DB access
- Exports `retrieveContext(query)` which:
  1. Calls `embedQuery()` to embed the user's question
  2. Calls the `match_documents` Supabase RPC function with the embedding, `RAG_MATCH_COUNT`, and `RAG_MATCH_THRESHOLD`
  3. Formats matched documents into `Source` objects (title, subtitle, url, snippet, content)
  4. Builds `contextText` — a formatted string of all retrieved chunks prefixed with source labels
- Defines the `Source` type used throughout the application
- Contains helper functions for formatting source metadata (month names, publication types)

---

## 2. Database Schema (Supabase Migrations)

### `C:\Users\alexa\Desktop\jw-assistant\supabase\migrations\005_documents.sql`
- **Role**: Defines the vector store table
- Creates the `documents` table with columns: `id` (BIGINT), `content` (TEXT), `metadata` (JSONB), `embedding` (VECTOR(3072))
- Requires the pgvector extension
- RLS policy restricts access to `service_role` only (backend RAG ingestion/retrieval)

### `C:\Users\alexa\Desktop\jw-assistant\supabase\migrations\006_match_documents.sql`
- **Role**: Similarity search RPC function
- Creates `match_documents(query_embedding, match_count, match_threshold)` PL/pgSQL function
- Uses cosine distance operator (`<=>`) for similarity scoring: `1 - (embedding <=> query_embedding)`
- Filters results by `match_threshold` and limits to `match_count`
- Returns: `id`, `content`, `metadata`, `similarity`

### `C:\Users\alexa\Desktop\jw-assistant\supabase\migrations\002_conversations_messages.sql`
- **Role**: Message persistence with source storage
- The `messages` table includes a `sources` JSONB column (nullable) that stores the RAG source metadata attached to each assistant response
- Sources are persisted so they can be reloaded when a conversation is revisited

### `C:\Users\alexa\Desktop\jw-assistant\supabase\migrations\003_config.sql`
- **Role**: System prompt storage
- The `config` table stores the system prompt (key: `system_prompt`) that is prepended to the RAG context before being sent to the LLM
- The system prompt instructs the LLM how to use the retrieved context

### `C:\Users\alexa\Desktop\jw-assistant\supabase\migrations\004_rls_policies.sql`
- **Role**: Row-Level Security for all tables including messages (which carry source data)

---

## 3. API Routes

### `C:\Users\alexa\Desktop\jw-assistant\app\api\chat\route.ts`
- **Role**: The central orchestration point of the RAG pipeline
- POST handler that:
  1. Authenticates the user and verifies conversation ownership
  2. Extracts the last user message text
  3. Calls `retrieveContext(userText)` to get RAG context and sources
  4. Fetches the system prompt from the `config` table
  5. Constructs the augmented system prompt: `{system_prompt}\n\n---\nContext from knowledge base:\n\n{contextText}\n---`
  6. Streams the LLM response via `streamText()` using the provider abstraction
  7. Persists the assistant message with sources in `onFinish` callback
  8. Sends sources to the client via `source-url` stream parts with metadata in `providerMetadata.custom`

### `C:\Users\alexa\Desktop\jw-assistant\app\api\admin\config\route.ts`
- **Role**: Admin management of the system prompt
- GET/PUT endpoints for reading and updating the system prompt that frames all RAG-augmented responses

---

## 4. UI Components (Source Display)

### `C:\Users\alexa\Desktop\jw-assistant\components\chat\chat-area.tsx`
- **Role**: Client-side RAG source extraction from the stream
- Uses `useChat` hook with `onFinish` callback to extract `source-url` parts from streamed messages
- Maintains `messageSources` state (Record mapping message IDs to Source arrays)
- Passes `messageSources` down to `MessageList`

### `C:\Users\alexa\Desktop\jw-assistant\components\chat\message-list.tsx`
- **Role**: Renders the sources button on assistant messages
- For each assistant message that has sources in `messageSources`, renders a `SourcesButton` component below the message

### `C:\Users\alexa\Desktop\jw-assistant\components\chat\sources-button.tsx`
- **Role**: Toggle button for the sources sidebar
- "Sources" button below assistant messages that opens/closes the right sidebar
- Passes the message's sources to the layout context via `setSources()`

### `C:\Users\alexa\Desktop\jw-assistant\components\sidebar\right-sidebar.tsx`
- **Role**: Sources sidebar panel
- Reads `sources` from layout context and renders a `SourceCard` for each
- Tracks which sources have been visited via `visitedSources` state

### `C:\Users\alexa\Desktop\jw-assistant\components\sources\source-card.tsx`
- **Role**: Individual source display card
- Shows title, subtitle, and snippet in a card format
- Click opens a dialog with the full source content
- Tracks visited state with a checkmark indicator

### `C:\Users\alexa\Desktop\jw-assistant\app\(protected)\layout.tsx`
- **Role**: State management for sources across components
- Manages `sources`, `setSources`, `visitedSources`, `markSourceVisited`, `selectedMessageId` in the layout context
- Provides the three-panel layout (left sidebar, chat, right sources sidebar)

### `C:\Users\alexa\Desktop\jw-assistant\app\(protected)\chat\[id]\page.tsx`
- **Role**: Server-side source rehydration
- Loads persisted sources from the `messages.sources` JSONB column when a conversation is revisited
- Builds `initialSources` map and passes it to `ChatArea` for immediate display without re-running RAG

---

## 5. Supporting Files

### `C:\Users\alexa\Desktop\jw-assistant\lib\ai\provider.ts`
- **Role**: LLM provider abstraction
- Returns the configured LLM model instance used by `streamText()` in the chat route
- Supports OpenAI, Anthropic, and Google via environment variables

### `C:\Users\alexa\Desktop\jw-assistant\lib\supabase\server.ts`
- **Role**: Server-side Supabase client factory
- Used by the chat API route for session verification and conversation ownership checks

### `C:\Users\alexa\Desktop\jw-assistant\.env.local.example`
- **Role**: Documents RAG-specific environment variables
- `OPENAI_API_KEY` — required for embeddings regardless of LLM provider
- `RAG_MATCH_COUNT` — number of chunks to retrieve (default: 5)
- `RAG_MATCH_THRESHOLD` — minimum similarity score (default: 0.7)

---

## 6. Documentation

### `C:\Users\alexa\Desktop\jw-assistant\docs\design-specs.md`
- **Role**: Full design specification
- Section 5 (lines 153-253) details the complete RAG pipeline design: overview, vector table schema, retrieval function, configurable parameters, context injection format, and source extraction

### `C:\Users\alexa\Desktop\jw-assistant\docs\plans\2026-03-13-rag-assistant-mvp.md`
- **Role**: Implementation plan
- Tasks 11-12 cover RAG retrieval utilities and the chat API route with streaming
- References to the design specs for RAG pipeline details

### `C:\Users\alexa\Desktop\jw-assistant\CLAUDE.md`
- **Role**: Project instructions
- Documents the RAG architecture, key conventions, and environment variables

---

## Data Flow Summary

```
User sends message
  -> app/api/chat/route.ts (POST handler)
    -> lib/rag/retrieve.ts :: retrieveContext()
      -> lib/rag/embed.ts :: embedQuery()  [OpenAI text-embedding-3-large]
      -> Supabase RPC: match_documents()   [006_match_documents.sql]
        -> documents table                 [005_documents.sql]
      <- Returns: contextText + Source[]
    -> Fetches system_prompt from config table [003_config.sql]
    -> Augments system prompt with contextText
    -> streamText() via lib/ai/provider.ts
    -> Streams response + source-url parts to client
    -> onFinish: persists message + sources to messages table [002_conversations_messages.sql]
  <- Client receives stream
    -> components/chat/chat-area.tsx extracts source-url parts
    -> components/chat/message-list.tsx renders SourcesButton
    -> components/chat/sources-button.tsx toggles right sidebar
    -> components/sidebar/right-sidebar.tsx displays SourceCards
    -> components/sources/source-card.tsx shows individual source details
```
