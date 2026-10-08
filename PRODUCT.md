# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

One person managing shared household expenses from a local desktop browser.

## Product Purpose

SplitMate collects household receipt images from WhatsApp, lets the owner verify uncertain receipts, calculates equal shares, and records a clear payment plan. Success means the owner can reconcile a settlement period quickly without losing receipts or accidentally marking an unpaid transfer as complete.

## Positioning

A private, local-first reconciliation workspace that joins receipt evidence, review, arithmetic, and payment confirmation in one recoverable flow.

## Operating Context

The owner chooses a WhatsApp household group and a settlement date range, syncs receipt images through the current date, reviews OCR results and manual expenses, then confirms payments after money changes hands. Saved settlement records are kept in a local JSON file. WhatsApp and Gemini are optional integrations for collection and recognition.

## Capabilities and Constraints

- Desktop web application; mobile UI is out of scope.
- Existing WhatsApp Web session, local receipt cache, local media cache, user aliases, and settlement history must remain usable.
- The workflow supports manual expenses, OCR receipt collection, duplicate review, excluded receipts, exact cent-based settlement, payment confirmations, closing a settlement, JSON workspace backup, offline draft recovery, and saved history.
- Sync must load messages from the settlement start date through today, preserve user edits and exclusions, and avoid duplicate receipts.
- The application must never send WhatsApp messages or initiate bank payments.
- API keys and WhatsApp authentication data must not enter browser backups.

## Brand Commitments

The product is named SplitMate. The user asked for a professional, minimal, functional desktop dashboard with Apple-like restraint, clear workflow, and useful motion.

## Evidence on Hand

- Existing local implementation in this repository.
- Existing Personal IOS project at `D:\My Future\Personal IOS\IOS-PERSONAL` used as a reference for restrained typography, progressive disclosure, and system-like interaction.
- Real local WhatsApp session and configuration files are present; no fabricated receipts or payment claims should be introduced.

## Product Principles

1. Keep the current settlement and its period visible while the owner works.
2. Make the next useful action obvious and keep advanced choices secondary.
3. Preserve evidence and drafts when integrations fail or the browser goes offline.
4. Treat review and payment confirmation as deliberate user decisions.
5. Explain errors beside the affected workflow with a direct recovery action.

## Accessibility & Inclusion

Keyboard navigation, visible focus, readable contrast, semantic labels, reduced-motion support, and clear disabled/loading/error/success states are required for the desktop workflow.
