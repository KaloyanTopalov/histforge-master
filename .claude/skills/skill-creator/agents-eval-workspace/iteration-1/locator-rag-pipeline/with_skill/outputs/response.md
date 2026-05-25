## File Locations for the RAG Pipeline

Here are all files related to the RAG pipeline, organized by purpose:

---

### Core RAG Implementation

- `lib/rag/embed.ts` - Query embedding using OpenAI text-embedding-3-large (3072 dimensions)
- `lib/rag/retrieve.ts` - pgvector similarity search; exports `retrieveContext`, returns `contextText` and `sources`

### API Route (RAG Entry Point)

- `app/api/chat/route.ts` - Imports `retrieveContext` from `lib/rag/retrieve`, calls it on the user message, passes context into the LLM prompt, and streams `source-url` parts back to the client

### Database Migrations

- `supabase/migrations/005_documents.sql` - Creates the `documents` table (stores chunks with embeddings)
- `supabase/migrations/006_match_documents.sql` - Creates the `match_documents` SQL function used by pgvector similarity search

### Source Display UI Components

- `components/sources/source-card.tsx` - Card component for rendering a single retrieved source
- `components/sidebar/right-sidebar.tsx` - Sidebar that lists all sources for the selected message using `SourceCard`
- `components/chat/message-list.tsx` - Renders per-message `SourcesButton` when sources are present
- `components/chat/sources-button.tsx` - Button on assistant messages that opens the sources panel
- `components/chat/chat-area.tsx` - Extracts `source-url` stream parts and tracks them as message sources

### Configuration

- `.env.local.example` - Documents `OPENAI_API_KEY`, `RAG_MATCH_COUNT`, and `RAG_MATCH_THRESHOLD` environment variables
- `.env` - Active environment variable values including RAG tuning parameters

### Documentation

- `docs/plans/2026-03-13-rag-assistant-mvp.md` - MVP plan referencing the RAG pipeline
- `docs/design-specs.md` - Design specs mentioning vector/similarity search
- `.claude/skills/domain-chat-rag/SKILL.md` - Skill guide for the chat UI, streaming, and RAG pipeline
- `.claude/skills/domain-chat-rag/references/current-state.md` - Current-state reference for the RAG domain

---

### Related Directories

- `lib/rag/` - Contains 2 files: `embed.ts` and `retrieve.ts`
- `components/sources/` - Contains 1 file: `source-card.tsx`
- `supabase/migrations/` - Contains 6 total SQL migrations; files `005` and `006` are RAG-specific
