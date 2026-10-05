# v1.7.3 — PostgreSQL, Artifacts & Stability Release

This release delivers the platform's PostgreSQL migration, meeting state isolation fixes, improved recording workflows, artifact-based meeting continuity, and a collection of usability improvements.

## PostgreSQL Support

The platform now supports PostgreSQL as the primary production database.

### Implementation

- db.js uses PostgreSQL via pg Pool when DATABASE_URL is configured
- Automatic SQLite fallback when DATABASE_URL is not set
- Async database operations across the application
- Production-ready PostgreSQL connection management

### Schema Additions

Core tables:

- users
- history
- membership
- recordings

New tables:

- meeting_artifacts
- chat_messages
- personal_notes

Recording enhancements:

- file_path
- file_url

### Migration

SQLite data can be migrated using:

\`\`\`bash
npm run migrate:sqlite-to-pg
\`\`\`

## Async Database Layer

All database operations have been converted to asynchronous workflows.

Updated areas:

- Routes
- Plugins
- Authentication
- Meeting lifecycle handlers
- Data access APIs

This improves PostgreSQL compatibility, reliability, and scalability.

## Meeting State Isolation

Resolved meeting state leakage between sessions.

### resetMeetingState()

Meeting cleanup now resets:

- Chat messages
- Reactions
- Timeline events
- Shared notes
- Recording state
- Meeting timers

This guarantees a clean state for every new meeting.

## Recording Experience

Recording controls have been redesigned for clarity.

### New Workflow

- Start Recording
- Stop Recording
- Recorded → Artifacts

### Improvements

- Start button disabled while recording is active
- Clear recording status
- Meeting-linked recordings
- Recording discoverability through Artifacts

## User Experience Improvements

### Chat Input

- Improved styling
- Better usability
- Enhanced message entry experience

### End Call

- Improved visibility
- Easier access during meetings

### Reactions

- ❤️ reaction updated to 😊
- Removed redundant "Reactions" label

### Meeting Timer

- Live meeting duration tracking
- Better meeting awareness

## Artifacts System

Meeting outputs are now preserved as reusable artifacts.

### Artifact Creation

Artifacts are automatically created when a meeting ends.

### API

- GET /api/artifacts/*
- POST /api/artifacts/*

### History Integration

Users can:

- View previous artifacts
- Open artifacts from History
- Continue previous work

### Artifact Viewer

Dedicated artifact viewing experience with meeting context and outputs.

### Permanent URLs

Artifacts now support permanent deep links:

\`\`\`text
/m/{code}/{slug}
\`\`\`

### Restart From Artifact

Hosts can restart a meeting directly from an existing artifact.

Benefits:

- Recover context
- Continue discussions
- Resume planning sessions

## Private Personal Notes

Introduced private notes tied to meetings and artifacts.

Features:

- Personal-only visibility
- Persisted across sessions
- Artifact-linked storage
- Not shared with participants

## Running With PostgreSQL 18

\`\`\`bash
cd meet
npm install

# DATABASE_URL=postgresql://user:pass@host:5432/meet

node server.js
\`\`\`

### Health Check

\`\`\`text
/health
\`\`\`

Reports:

\`\`\`json
{
  "postgres": true
}
\`\`\`

when DATABASE_URL is configured.

## Coolify Deployment

Recommended setup:

- PostgreSQL 18 service
- DATABASE_URL configured on Meet
- Optional /app/data volume
- Run migration if migrating from SQLite

## Release Summary

v1.7.3 establishes PostgreSQL as a first-class deployment option while introducing artifact-based meeting continuity, improved recording workflows, private notes, stronger state isolation, and multiple usability enhancements across the platform.
