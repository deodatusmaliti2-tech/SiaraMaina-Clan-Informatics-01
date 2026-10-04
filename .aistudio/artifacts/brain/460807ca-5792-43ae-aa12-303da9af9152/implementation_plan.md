# Supabase Database Migration & Robust Real-Time Informatics System

This plan outlines the system architecture, database schema, data mappings, security layers, Stripe webhook integration, and real-time syncing pipelines to migrate the SiaraMaina Clan Informatics database from an unstable, local file-based JSON mechanism to an enterprise-grade, highly-available Supabase platform.

## User Review & Critical Decisions

> [!IMPORTANT]
> This migration replaces all active data storage in-place, keeping the frontend and backend in a unified repository with 100% feature preservation. Please review the database schema and security assertions before giving consent.

*   **Confirmed Decision 1**: All JSON credentials and users (`users.json`) will be securely migrated to native Supabase Auth users using automatic password fallback and unified database mapping.
*   **Confirmed Decision 2**: Automatic deployment and synchronization setups will be bootstrapped automatically using the provided credentials.
*   **Confirmed Decision 3**: Stripe Webhook checking will run using full cryptographic signature checks with fallback verification against the Stripe API (Option 2).
*   **Open Question / Choice 1 (Recommended)**: To facilitate high-fidelity photography archival, we recommend storing clan portrait photos in a public `clan-avatars` Supabase Storage bucket, auto-optimizing uploaded imagery via backend proxy rules.

---

## 1. Overview & Core Concept

*   **What It Does**: Upgrades the entire relational structure of the SiaraMaina family tree, metadata logs, transactions, and admin profile scopes from a local locking file server to PostgreSQL on Supabase.
*   **Target Audience**: Clan admins, editors, and family descendants who collaborate to register ancestors, trace branches, verify educational profiles, and coordinate mutual aid contributions.
*   **Key Value**: Prevents local file-system writes, race conditions on multi-user edits, corruption risks, and browser refresh lag through immediate real-time DB triggers and auto-reconnecting WebSocket notifications.

---

## 2. User Experience & Visual Design

*   **Visual Continuity & Theme**: Maintains the professional, editorial styling with Plus Jakarta Sans body fonts, high-character display titles, unified spacing padding math ($\ge$ 16px), and a clean, light/dark posture.
*   **Real-time Interaction Feedback**:
    *   *Real-time Sync Badge*: A persistent header indicator reflecting Connection Status (`Online`, `Offline`, `Synchronizing...`).
    *   *Simultaneous Edit Guard*: If an editor attempts to update a record modified since their last load, a modern modal appears showing a merge resolution panel with "Keep Mine", "Use Server Version", or "Cancel".
    *   *Save & Sync Toast alerts*: Sliding micro-notifications detailing when remote changes affect the current view.
*   **Offline Support**:
    *   *Optimistic Operations*: Instantly reflects local edits in user views with an asynchronous syncing indicator.
    *   *Queue Manager*: Queues edit requests in memory during disconnects, and drains them cleanly with validation on connection restore.

---

## 3. Key Product Decisions & Trade-Offs

*   **Decision 1: Relational Schema vs. JSON Column Storage**
    *   *Chosen Approach*: Fully normalized tables with recursive self-referential foreign keys (`spouse_id`, `father_id`, `mother_id`) referencing the same `records` table.
    *   *Why*: Preserves structural integrity, enforces referential integrity cascade rules, and allows rapid query indexing instead of parsing nested JSON rows.
*   **Decision 2: Supabase Auth to Public Profile Mapping**
    *   *Chosen Approach*: Maintain a secure public `profiles` table that synchronizes with `auth.users` via database triggers.
    *   *Why*: Allows non-authenticated and editor clients to securely read display names and branch roles without querying the private auth schema.

---

## 4. Technical Architecture & Data Strategy

### System Architecture Flow

```
                      ┌──────────────────────────────────────┐
                      │        SiaraMaina Frontend UI        │
                      └──────────┬─────────────────▲─────────┘
                                 │                 │
                      REST API / Auth           Real-time Websocket
                                 │                 │
                                 ▼                 │
     ┌─────────────────────────────────────────────┼─────────────────────────┐
     │ Server-Side Proxy Routes (Express)          │                         │
     │ ├─ /api/auth/* ──► Handles Auth Credentials │                         │
     │ ├─ /api/db/* ────► Audited Data Proxies     │                         │
     │ └─ /api/stripe/* ─► Payment & Webhooks      │                         │
     └───────┬─────────────────────────────────────┼─────────────────────────┘
             │                                     │
             │ Secure Operations                   │ Realtime PubSub
             ▼                                     │
 ┌─────────────────────────────────────────────────┴─────────────────────────┐
 │ Supabase Platform & Services                                              │
 │ ├─ Auth System ─────► User registration & JWT tokens                      │
 │ ├─ Storage Bucket ──► Avatar photos & lineage certificates                │
 │ └─ PostgreSQL DB ───► Normalized structural engine                        │
 │     ├─ profiles ────► User roles and access permissions                   │
 │     ├─ records ─────► Relational clan members (recursive keys)           │
 │     ├─ payments ────► Cryptographically checked Stripe sessions           │
 │     └─ audit_logs ──► Strict action tracker                               │
 └───────────────────────────────────────────────────────────────────────────┘
```

### Database Schema Definition

#### 1. `profiles`
*Tracks users, access metadata, and security roles.*
*   `id` (UUID, Primary Key, references `auth.users` ON DELETE CASCADE)
*   `email` (VARCHAR, Unique, Validation: RFC 5322 format)
*   `display_name` (VARCHAR, NOT NULL)
*   `role` (VARCHAR, NOT NULL, CHECK in `('admin', 'editor', 'viewer')`, default: `'viewer'`)
*   `institution` (VARCHAR, default: `'SiaraMaina Clan Informatics'`)
*   `branch` (VARCHAR, default: `'all'`)
*   `active` (BOOLEAN, default: `true`)
*   `created_at` (TIMESTAMPTZ, default: `now()`)
*   `updated_at` (TIMESTAMPTZ, default: `now()`)

#### 2. `records`
*Stores the family ancestors and branch descendants.*
*   `id` (UUID, Primary Key, default: `gen_random_uuid()`)
*   `first_name` (VARCHAR, NOT NULL, Validation: Length > 1)
*   `last_name` (VARCHAR, NOT NULL)
*   `email` (VARCHAR, CHECK: matches email patterns or is empty)
*   `whatsapp` (VARCHAR)
*   `location` (VARCHAR)
*   `occupation` (VARCHAR)
*   `education` (VARCHAR)
*   `branch_type` (VARCHAR, NOT NULL, CHECK in `('heritage', 'alliance', 'branch_member')`)
*   `marital_status` (VARCHAR, default: `'Not Recorded'`)
*   `spouse_id` (UUID, References `records(id)` ON DELETE SET NULL)
*   `father_id` (UUID, References `records(id)` ON DELETE SET NULL)
*   `mother_id` (UUID, References `records(id)` ON DELETE SET NULL)
*   `deceased` (BOOLEAN, default: `false`)
*   `dob` (VARCHAR)
*   `dod` (VARCHAR)
*   `cause_of_death` (VARCHAR, default: `'Not Recorded'`)
*   `narrative` (TEXT)
*   `photo` (TEXT)
*   `course` (VARCHAR)
*   `organization` (VARCHAR)
*   `created_at` (TIMESTAMPTZ, default: `now()`)
*   `updated_at` (TIMESTAMPTZ, default: `now()`)

#### 3. `payments`
*Logs transactions and Stripe payment sessions.*
*   `id` (UUID, Primary Key, default: `gen_random_uuid()`)
*   `user_id` (UUID, References `profiles(id)` ON DELETE CASCADE)
*   `checkout_session_id` (VARCHAR, Unique, NOT NULL)
*   `amount` (INTEGER, NOT NULL)
*   `currency` (VARCHAR, NOT NULL)
*   `status` (VARCHAR, NOT NULL, CHECK in `('pending', 'succeeded', 'failed')`)
*   `idempotency_key` (VARCHAR, Unique, NOT NULL)
*   `metadata` (JSONB)
*   `created_at` (TIMESTAMPTZ, default: `now()`)
*   `updated_at` (TIMESTAMPTZ, default: `now()`)

#### 4. `audit_logs`
*Unmodifiable tracking history of all administrative operations.*
*   `id` (UUID, Primary Key, default: gen_random_uuid())
*   `user_id` (UUID, References `profiles(id)` ON DELETE SET NULL)
*   `action` (VARCHAR, NOT NULL)
*   `details` (JSONB)
*   `ip_address` (VARCHAR)
*   `user_agent` (VARCHAR)
*   `created_at` (TIMESTAMPTZ, default: `now()`)

---

## 5. Security & Access Rules (RLS Policies)

We will lock all tables down with PostgreSQL Row Level Security (RLS) to enforce strict access boundaries:

```sql
-- Enable RLS on all schemas
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE records ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

-- 1. Profiles Rules
CREATE POLICY "Public Profiles can be viewed by anyone" ON profiles
  FOR SELECT USING (active = true);

CREATE POLICY "Users can edit their own profiles" ON profiles
  FOR UPDATE USING (auth.uid() = id);

-- 2. Records Rules
CREATE POLICY "Anyone can read clan records" ON records
  FOR SELECT USING (true);

CREATE POLICY "Admins and Editors can update/insert records" ON records
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM profiles 
      WHERE id = auth.uid() AND role IN ('admin', 'editor') AND active = true
    )
  );

-- 3. Payments Rules
CREATE POLICY "Users can read their own payments" ON payments
  FOR SELECT USING (auth.uid() = user_id);

-- 4. Audit Logs Rules
CREATE POLICY "Only admins can view audit logs" ON audit_logs
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM profiles 
      WHERE id = auth.uid() AND role = 'admin' AND active = true
    )
  );
```

---

## 6. Migration & Verification Flowchart

```
┌────────────────────────────────────────┐
│  Phase 1: Freeze Writes & Create Local │
│  JSON Backups in `/data/backups/`      │
└───────────────────┬────────────────────┘
                    │
                    ▼
┌────────────────────────────────────────┐
│  Phase 2: Bootstrap Supabase Instance  │
│  And Create Tables via Migrations      │
└───────────────────┬────────────────────┘
                    │
                    ▼
┌────────────────────────────────────────┐
│  Phase 3: Populate Tables Using Custom  │
│  Data Loader, Enforce Integrity Keys   │
└───────────────────┬────────────────────┘
                    │
                    ▼
┌────────────────────────────────────────┐
│  Phase 4: Run Health Diagnostics and   │
│  Switch Frontend API Calls to Supabase │
└────────────────────────────────────────┘
```

---

## 7. Configuration & Environment Variables

Create `.env` file with these parameters (never commit to version control):

```env
# Client-Side Credentials
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...

# Server-Side Secrets (Highly Protected)
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
STRIPE_SECRET_KEY=sk_test_51...
STRIPE_WEBHOOK_SECRET=whsec_...
PORT=8080
```

*Proceed with safety validations. No file modifications will begin until you review and confirm this blueprint.*
