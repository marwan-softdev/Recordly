# Desktop feedback

Before releasing feedback submission:

1. Apply `migrations/202609230001_feedback.sql` and then `migrations/202609230002_feedback_limits.sql` in the configured Supabase project. If the first migration is already applied, apply only the second.
2. Deploy the `submit-feedback` Edge Function from the repository root with the Supabase CLI: `supabase functions deploy submit-feedback --workdir services --project-ref YOUR_PROJECT_REF`. The function explicitly validates the bearer token with `auth.getUser` before parsing or storing feedback. The function configuration disables only the gateway's JWT check, not the function's authentication.
3. Use the project's built-in `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` secrets for the function. Never put a service-role key in the desktop app.

The desktop client calls the function with its existing signed-in session. Direct client report inserts and attachment uploads are disabled by the second migration. The function validates subject/message lengths, diagnostics bytes, and the actual uploaded files (five nonempty files, 10 MB total per submission), and caps the incoming request body. It reserves a per-account UTC daily quota atomically: 10 submission attempts, 25 files, and 50 MB. Failed attempts still consume quota, so repeated upload/delete/retry cycles do not reset it. No Storage schema triggers or modifications are required beyond the access policies.

Feedback is stored in `public.feedback_reports`. View reports through the Supabase dashboard and retrieve attachments from the private `feedback-attachments` bucket using each report's attachment paths. Owners can read their own reports; other users cannot. Staff use server-side service-role access. There is no email notification or public issue creation.

On submission, the modal captures up to 100 recent renderer warnings/errors (2,000 characters each), browser/platform details, and a timestamp. Common secrets, URLs, emails, and local home paths are redacted. Arbitrary log objects are not serialized. The final JSON is bounded to 290,000 UTF-8 bytes by dropping oldest entries, below the database's 300,000-byte limit. Diagnostics are automatically included; native-process logs are not collected. Attachments are chosen explicitly.

A local demo account can preview the form but cannot submit without a real Supabase session. Failed submissions retain the draft in memory; closing and reopening the same modal keeps it, but restarting the app does not. The function cleans up failed uploads on a best-effort basis. Periodically remove unattached objects left by interrupted sessions through the Storage API, and prune old `feedback_daily_usage` rows after their UTC day has ended.

Unit tests exercise the server handler with an injected storage/auth backend. `tests/feedback_limits.sql` verifies the migration's quotas and permissions in a disposable database with the migrations applied; it rolls back its test data. Live deployment and end-to-end Supabase uploads must be checked separately before release.
