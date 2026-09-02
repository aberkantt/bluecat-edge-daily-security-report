# Security Policy

This project processes security findings that may contain customer names,
internal IP addresses, queried domains, email addresses, and operational
metadata. Keep production data out of the repository.

## Secrets

Store all credentials and deployment-specific values in Google Apps Script
Script Properties. Never commit any of the following:

- BlueCat client credentials or access tokens
- Production BlueCat URLs
- Customer email addresses
- Google Drive folder or spreadsheet IDs
- Generated JSON, CSV, PDF, or log files

If a secret is committed, remove it from the repository history and rotate it
immediately. Deleting it only from the latest commit is not sufficient.

## Reporting a vulnerability

Do not open a public issue containing credentials, customer data, raw API
responses, or internal network details. Use the repository's private GitHub
security-advisory flow instead.
