---
name: SplitMate
description: A quiet local workspace for collecting, checking, and settling shared expenses.
colors:
  accent: "#0071e3"
  background: "#f5f5f7"
  surface: "#ffffff"
  sidebar: "#ededf0"
  text: "#202124"
  muted: "#65666e"
  line: "#e4e4e9"
  selected: "#eaf3ff"
  warning: "#815300"
  warning-bg: "#fff8e9"
  green: "#207249"
typography:
  headline:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "30px"
    fontWeight: 650
    lineHeight: 1.2
    letterSpacing: "-1px"
  metric:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "27px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.8px"
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "12px"
    fontWeight: 550
    lineHeight: 1.4
rounded:
  sm: "7px"
  md: "12px"
  lg: "16px"
  pill: "999px"
spacing:
  sm: "8px"
  md: "16px"
  lg: "24px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "#ffffff"
    rounded: "{rounded.sm}"
    padding: "9px 15px"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.sm}"
    padding: "9px 15px"
---

# Design System: SplitMate

## Overview

**Creative North Star: “The Quiet Audit Register”**

SplitMate should feel like a trusted local instrument: calm enough to use every week, precise enough to trust when the numbers matter. The interface uses a restrained system sans, quiet surfaces, one blue action color, and evidence-first hierarchy. The settlement period and next useful action remain visible while the owner moves through the workflow.

The visual language borrows the directness of a paper ledger and the scanability of an operations board. Motion confirms state changes and guides attention; it never competes with receipt evidence or payment decisions. The desktop layout is intentionally spacious and keyboard-friendly.

**Key Characteristics:**

- One visible path: Collect → Review → Settle.
- Flat tonal surfaces with borders; elevation appears only for focus, dialogs, and transient status.
- System typography and authored SVG icons instead of decorative glyphs.
- Motion is short, interruptible, and removed when reduced motion is requested.

## Colors

Warm neutral surfaces carry most of the interface. Blue is reserved for the current step and the next useful action; warning amber and green communicate review and completion states.

### Primary

- **Clear blue** (#0071e3): primary actions, active workflow step, and selected receipt edge.

### Neutral

- **Window grey** (#f5f5f7): application background and empty-state surfaces.
- **Paper white** (#ffffff): panels, fields, and dialog surfaces.
- **Sidebar grey** (#ededf0): navigation rail.
- **Ink** (#202124): headings and important values.
- **Quiet ink** (#65666e): supporting copy, metadata, and inactive controls.
- **Divider** (#e4e4e9): structural separation.

### Named Rules

**The One Accent Rule.** Keep the blue action color rare. It marks the next step or a current selection, never decoration.

## Typography

**Display Font:** system sans (`-apple-system`, BlinkMacSystemFont, “Segoe UI”, sans-serif)

**Body Font:** the same system sans stack for a native desktop feel.

**Character:** compact, highly legible, and quiet. Use weight and spacing to establish hierarchy before changing color.

### Hierarchy

- **Headline** (650, 30px, 1.2): page title and primary orientation.
- **Title** (620, 18px, 1.3): panel and workflow headings.
- **Body** (400, 14px, 1.5): descriptions and form content.
- **Label** (550, 12px, 1.4): controls, metadata, and supporting labels.

## Layout

The desktop shell has a fixed 224px navigation rail and a fluid content column capped at 1800px. The current settlement header keeps the household, period, tabs, and three-step progress rail together. Overview is a dashboard: a four-card stats grid (total expenses, share per person, still to transfer, needs review), one highlighted next-step block, and two supporting panels. The header carries a WhatsApp connection pill; the rail bottom carries a connection card for the local server, WhatsApp session, and recognition keys. Receipts uses a list/detail split so verification never loses context. Spacing follows 8px increments, with 16–24px panel padding.

## Elevation & Depth

Surfaces are flat by default. Borders and tonal changes establish structure. A soft ambient shadow is reserved for dialogs and the transient toast; selected rows use an inset accent edge rather than a floating card effect.

## Shapes

Controls use 7px corners, panels use 12px, and dialogs use 16px. Borders are one pixel and low contrast. Avatars are circular; receipt and status marks are compact rounded squares or circles.

## Components

### Buttons

- **Shape:** compact 7px corners with a 36px minimum height.
- **Primary:** blue fill, white text, 9px × 15px padding.
- **Hover / Focus:** subtle color shift and a visible blue focus ring; press feedback scales to 0.985.
- **Secondary / Ghost:** white or transparent surfaces with the same border language.

### Cards / Containers

- **Corner Style:** 12px panels, 16px dialogs.
- **Background:** paper white on the window grey canvas.
- **Shadow Strategy:** flat at rest; dialogs and toast may use the ambient shadow.
- **Border:** one pixel divider color.
- **Internal Padding:** 16–24px depending on content density.

### Stat cards

Overview metrics live in four equal cards. Each card holds a small muted label with a matching icon at the right edge, one large tabular-numeral value (27px, weight 600), and a one-line detail. A faint oversized watermark of the same icon sits in the bottom-right corner. Cards stay flat; hover deepens the border only.

### Status pills

Connection and balance states use rounded pills with a 6px dot and tinted background: green for connected, settled, or receiving; amber for pairing, missing keys, or owing; neutral grey for offline. Pills are informational; they never carry the only copy of an error.

### Connection card

The rail bottom lists the local server, the WhatsApp session, and receipt recognition keys, each with a status dot and one line of plain language. It is always visible so readiness is checkable before syncing.

### Inputs / Fields

- **Style:** white field, one pixel divider, 7px radius, 9px vertical padding.
- **Focus:** blue outline ring without layout shift.
- **Error / Disabled:** amber inline message for review; disabled controls reduce opacity and retain their label.

### Navigation

The left rail is stable and quiet. The active item uses a white tonal tile and blue icon. The settlement tabs and progress rail are a second, local navigation layer; they preserve the current period while the owner moves through each stage.

### Workflow rail

Collect, Review, and Settle are the only primary stages. The active step scales slightly and fills blue; completed steps and connecting rules fill progressively. The rail is informational and each stage remains reachable through the tabs.

## Do's and Don'ts

- Do make the next useful action obvious on the Overview screen.
- Do keep uncertain receipts visible and explain how to recover from an error beside the affected action.
- Do use authored SVG geometry for interface icons and accessible text for labels.
- Do animate state changes with opacity and small transforms, generally under 300ms.
- Do respect `prefers-reduced-motion`.
- Don't add charts, decorative gradients, or extra dashboard tiles without a decision they help the owner make.
- Don't hide receipt evidence behind navigation or replace an error with a generic success state.
