# BlueCat Edge Daily Security Report

[Türkçe dokümantasyon](README.tr.md)

Google Apps Script automation that collects daily BlueCat Edge security
findings, archives the underlying data, maintains a historical view, creates an
executive PDF, and delivers the report by email.

> This is an independent community project and is not an official BlueCat
> Networks product. BlueCat and related product names are trademarks of their
> respective owners.

## What it does

- Authenticates to BlueCat Edge with client credentials.
- Retrieves site metadata and the daily most-compromised-endpoints report.
- Maps findings to sites and distinguishes DNS forwarders when the API exposes
  the required topology data.
- Archives the raw JSON and normalized CSV in Google Drive.
- Maintains daily summaries, detailed findings, and domain-review state in a
  Google Sheet.
- Generates a three-page management PDF through Google Slides.
- Sends HTML email with PDF attachment, optional CC recipients, and a separate
  technical error notification.
- Supports safe test mode, execution locking, retry handling, and duplicate
  production-email protection.

## Repository layout

```text
bluecat-edge-daily-security-report/
├── src/
│   ├── Code.gs
│   └── appsscript.json
├── .clasp.json.example
├── .gitattributes
├── .gitignore
├── LICENSE
├── README.md
├── README.tr.md
└── SECURITY.md
```

## Requirements

- A BlueCat Edge API client with permission to obtain a token and read sites
  and security-report data.
- A BlueCat Edge base URL reachable from Google Apps Script.
- A Google account allowed to use Apps Script, Drive, Sheets, Slides, and Mail.

## Publish with GitHub Desktop

1. Extract the downloaded ZIP; it contains this single top-level project
   folder.
2. In GitHub Desktop, select **File → Add Local Repository** and choose
   `bluecat-edge-daily-security-report`.
3. If GitHub Desktop says the folder is not yet a Git repository, choose
   **create a repository here**.
4. Commit the files with a message such as `Initial release`.
5. Select **Publish repository**, set the visibility, and publish.

The packaged source contains no credentials, email addresses, customer name,
internal IP address, Drive ID, or generated report. Keep the repository private
if you later add environment-specific data.

## Script Properties

Open the Apps Script project and go to **Project Settings → Script
Properties**. Add deployment values there; do not place them in `Code.gs`.

| Property | Required | Purpose |
|---|---:|---|
| `BLUECAT_BASE_URL` | Yes | BlueCat Edge base URL, without a trailing slash |
| `BLUECAT_CLIENT_ID` | Yes | API client ID |
| `BLUECAT_CLIENT_SECRET` | Yes | API client secret |
| `ALERT_TO` | Yes | Test reports and technical error notifications |
| `TEST_MODE` | Yes | `TRUE` for safe testing, `FALSE` for production |
| `REPORT_TO` | Production | Primary production recipient |
| `REPORT_CC` | No | Comma-separated CC recipients |
| `REPORT_CUSTOMER_NAME` | No | Customer label shown in the email and PDF |

The script creates and maintains `ROOT_FOLDER_ID`,
`HISTORY_SPREADSHEET_ID`, and `LAST_SENT_REPORT_KEY` automatically. Do not add
these values to source control.

## Manual deployment

1. Create a standalone Google Apps Script project.
2. Replace the editor's default code with [`src/Code.gs`](src/Code.gs).
3. In **Project Settings**, enable display of the manifest file and replace it
   with [`src/appsscript.json`](src/appsscript.json).
4. Add the Script Properties listed above with `TEST_MODE=TRUE`.
5. Run `setupBlueCatWorkspace()` once and approve the requested Google scopes.
6. Run `testBlueCatConnection()` and confirm that it returns `SUCCESS` without
   logging credentials or tokens.
7. Run `runBlueCatDailyReport()` and verify that the test email, PDF, JSON, CSV,
   and history spreadsheet are produced correctly.
8. Add `REPORT_TO`, optionally add `REPORT_CC`, set `TEST_MODE=FALSE`, and run
   `runBlueCatDailyReport()` once for the production smoke test.
9. Run `installDailyTrigger()` once. The compatibility alias
   `createProductionDailyTrigger()` performs the same action.

The scheduled job runs daily at approximately 10:00 in the
`Europe/Istanbul` time zone. Use `removeDailyTrigger()` to remove the project's
daily report trigger.

## Optional clasp workflow

The repository is ready for a local Apps Script workflow with `clasp`:

1. Duplicate `.clasp.json.example` as `.clasp.json`.
2. Replace the placeholder with the target Apps Script project ID.
3. Authenticate with `clasp` and run `clasp push` from the repository root.

`.clasp.json` is intentionally ignored because the script ID is
deployment-specific.

## Test and production behavior

| Mode | Recipients | Subject prefix | Duplicate protection |
|---|---|---|---|
| `TEST_MODE=TRUE` | `ALERT_TO` only | `[TEST]` | Test reruns may send again |
| `TEST_MODE=FALSE` | `REPORT_TO` and optional `REPORT_CC` | None | One production email per report key |

The duplicate guard is stored in `LAST_SENT_REPORT_KEY`. Generated Drive files
are updated even when the production email for that report key was already
sent.

## Generated output

On first use, the automation creates a `BlueCat Security Reports` Drive folder
and a `BlueCat Security History` spreadsheet. Each report day receives its own
archive folder containing:

- Raw BlueCat JSON
- Normalized findings CSV
- Executive PDF report

The spreadsheet keeps daily summary, finding, and domain-review data used by
the report.

## Security and operational notes

- Keep `TEST_MODE=TRUE` until recipient and attachment validation is complete.
- Never commit Script Properties, generated reports, customer data, or raw API
  responses.
- Treat BlueCat vendor findings and scores as detection signals, not confirmed
  incidents. The report deliberately keeps vendor severity separate from
  analyst-review status.
- Review generated output before using the project in a new environment.
- See [SECURITY.md](SECURITY.md) before publishing a fork.

## Current scope

This release focuses on stable daily collection, archiving, PDF generation,
email delivery, and scheduling. External threat-intelligence enrichment,
AI-based triage, and automated false-positive suppression are not included in
this version.

## License

Released under the [MIT License](LICENSE).
