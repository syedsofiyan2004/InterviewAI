# Changelog — InterviewAI UI Modernization

All notable changes to the InterviewAI platform are documented here.

## [2026-04-23] — UI Overhaul & Enterprise Readiness

### Added
- **Persistent Theme Management**: Theme preference is now stored in `localStorage` and initialized via head script to prevent FOUC.
- **Custom UI System**: Created `ConfirmDialog`, `Toast`, and `StatusBadge` components to replace native browser behaviors and improve branding.
- **Dashboard Filtering**: Added "Filter by status" dropdown to the Recent Evaluations table.
- **Drag-and-Drop Uploads**: Upload cards now support file dragging and display the uploaded filename.
- **Enterprise Sidebar**: New dark-themed, compact sidebar (240px) with integrated user profile, theme toggle, and navigation.

### Changed
- **Global Typography Overhaul**: 
  - Replaced all uppercase labels/headers with sentence case for a more professional aesthetic.
  - Normalized font weights to a strict 2-weight system (`font-normal` and `font-semibold`).
  - Adjusted headings (Dashboard: `text-xl font-semibold`, View Page: `text-2xl font-semibold`).
- **Login Experience Redesign**: Full-page dark surface with a centered glassmorphic card, gradient branding, and premium input fields.
- **Evaluation View Modernization**:
  - Cleaned up header hierarchy.
  - Re-styled "Download PDF Report" as a prominent primary action.
  - Fixed progress bar formula and color thresholds for accuracy.
- **New Interview Flow**: Redesigned the progress stepper with connecting lines and clearer state indicators.
- **Dashboard Enhancements**:
  - Stat cards redesigned to follow financial dashboard patterns.
  - Tables now sorted by `created_at` descending by default.
  - Added a "nice" empty state for zero-evaluation scenarios.

### Fixed
- **Bug 1**: Fixed progress bar width formula and color logic in `view/page.tsx`.
- **Bug 2**: Removed redundant `ANALYZE` step and dead code in `new/page.tsx`.
- **Bug 3**: Fixed dashboard table sorting (defaulting to newest first).
- **Bug 4**: Replaced native `alert` and `confirm` dialogs with custom branded components.
- **Bug 5**: Cleaned up `Topbar` and moved user info/theme toggle to `Sidebar`.

### Removed
- **Unused UI Elements**: Removed the redundant search bar from `Topbar`.
- **Dead Config**: Deprecated `BEDROCK_HAIKU_PROFILE_ARN` in `infrastructure/.env.example`.
- **Placeholder Tags**: Removed the "Optional" badge from upload cards in favor of descriptive text.

---
*Senior Product Engineer & UI Designer*

## [2026-04-23] — Round 2 Fixes

### Changed
- **Login Redesign**: Replaced dark-mode-only layout with a professional two-column B2B SaaS layout featuring a branded feature sidebar and a clean, light-mode-first auth card.
- **Stat Cards**: Removed all-caps from titles and deleted placeholder "Live" footer. Updated titles to use sentence case (e.g., "Needs attention").
- **Sidebar**: Made the sidebar adaptive to light/dark themes using the `bg-surface` token. Removed the "NAVIGATION" label to reduce visual noise.
- **Sign Out**: Consolidated to a single "Sign out" text link at the bottom of the sidebar for better UX consistency.

## [2026-04-23] — Round 3 Fixes

### Changed
- **Results Modernization**:
    - Redesigned the Recommendation card with a premium border-based layout (`border-2 border-accent`) and refined typography.
    - Fixed a bug where Analysis Confidence could show values over 100% (safe handling for 0-1 and 0-100 ranges).
    - Removed decorative watermark icons from evidence cards for a cleaner, human-centric look.
    - Normalized evidence dimension tags to sentence case (`normal-case text-xs font-medium`).
    - Expanded evidence context display for better readability.
    - Normalized Executive Summary font weight to `font-normal`.
- **Sidebar Polish**: Fixed a layout bug in the sidebar footer where user info and theme controls were overlapping. Established a clean, vertically stacked layout.
- **Creation Flow**: 
    - Fixed truncated descriptions in document upload cards.
    - Updated navigation labels ("Continue to document upload" and "Submit for analysis") for better clarity.

## [2026-04-23] — Round 4 — Final Polish

### Changed
- **Sidebar Footer Rebuild**: Resolved persistent overlapping layout issues in the sidebar footer. The user info and global actions (Sign out, Theme toggle) now use a compact, two-row layout with precise icon scaling and typography.
- **Dynamic Topbar**: Replaced the static "Platform" header with a context-aware page title (e.g., "Dashboard", "Evaluation details") that updates automatically based on the current route.
- **UI Consistency**: Standardized text sizes and spacing in the navigation hub for a more refined, enterprise-grade feel.

## [2026-04-23] — Onboarding Tour

### Added
- **Interactive Tour**: Implemented a 4-step spotlight onboarding tour for first-time users.
    - Highlights key dashboard features: Executive Summary cards, New Interview creation, Evaluation tracking, and Workspace controls.
    - Uses a dynamic spotlight overlay with `clip-path` and real-time element tracking.
    - Persists completion state in `localStorage` to ensure it only shows once.
- **Tour Highlights**: Added specific IDs to dashboard and sidebar components to enable precise targeting during the onboarding flow.

## [2026-04-23] — Hydration Fix

### Changed
- **layout.tsx**: Added `suppressHydrationWarning` to the `<html>` tag. This resolves hydration mismatch warnings caused by the inline theme script that modifies the `dark` class on the client before React hydration.

## [2026-04-23] — Round 5 Visual Polish

### Changed
- **Dashboard Refinement**:
    - Replaced the generic "Executive Summary" header with dynamic stats showing total, completed, and in-progress evaluations.
    - Redesigned Stat Cards: Removed the boxed icon containers in favor of free-floating icons and added a subtle colored bottom accent border for each card.
    - Modernized Status Badges: Switched to a refined "colored dot + text" presentation in the dashboard table while preserving the high-visibility pill style for detail pages.
    - Enhanced Table Interactivity: Updated row hover states for better visibility in dark mode (`dark:hover:bg-slate-700/30`).
- **Dark Mode Architecture**: Updated global CSS tokens to improve visual depth and layering (better separation between background, surface, and elevated card elements).

## [2026-04-23] — Rebrand

### Changed
- **Global Rebranding**: Renamed the application from "InterviewAI" to **MinfyAI** across all display text, page titles, and metadata.
- **Visual Identity**: Updated the sidebar logo to a two-tone wordmark ("Minfy" in semibold, "AI" in normal weight) for better brand prominence.
- **Metadata**: Updated the root metadata to "MinfyAI" with a new descriptive tagline: "AI-powered interview evaluation platform by Minfy".
- **Login Experience**: Refreshed branding on the login page, including the left feature panel and the authentication forms.
- **Topbar**: Updated the fallback page title to "MinfyAI".

## [2026-04-23] — Round 7

### Changed
- **Brand Correction**: Renamed "MinfyAI" to **Minfy AI** (with space) across all display text, browser titles, and metadata.
- **Layout Stabilization**: 
    - Rebuilt the `AppShell` layout using high-specificity inline styles to eliminate a persistent sidebar gap. 
    - The sidebar wrapper now has a fixed width of `220px` with `flex-shrink: 0`, and the main content area uses `flex: 1` with `min-width: 0` to prevent layout overflows.
    - Updated the root container to `100vh` with `overflow: hidden` to ensure a consistent app-like experience.
- **Component Refinement**: Adjusted the `Sidebar` component to be internally flexible (`w-full h-full`), allowing it to seamlessly occupy the width defined by the `AppShell` layout.

## [2026-04-23] — Round 8 Gap Fix

### Changed
- **Layout Architecture**: 
    - Eliminated the redundant wrapper div around the `Sidebar` in `AppShell.tsx` to resolve width conflicts and horizontal gaps.
    - Simplified the authenticated shell structure, rendering the `Sidebar` directly alongside the main content area.
    - Removed legacy commented-out code from `AppShell.tsx` to maintain codebase cleanliness.
- **Sidebar Styling**:
    - Relocated the layout constraints (`width: 220px`, `border-r`) directly to the `Sidebar` component's root element for better encapsulation and layout reliability.
- **Topbar Navigation**: 
    - Updated the fallback page title to an empty string to avoid redundant branding on undefined routes.

## [2026-04-23] — Round 9 Alignment

### Changed
- **Header Uniformity**: Synchronized the heights of the sidebar logo area and the topbar to exactly `h-14` (56px), creating a seamless horizontal visual band across the top of the application.
- **Sidebar Refinement**: Adjusted the sidebar header padding (`px-5`) and layout to ensure perfect alignment with the new height constraints.
- **Topbar Styling**: Updated the topbar background to `bg-surface-elevated` and standardized its horizontal padding to `px-6` for better content alignment.

## [2026-04-23] — Evaluation Engine v2

### Changed
- **Model Configuration**: Increased `max_tokens` to 6000 and adjusted `temperature` to 0.1 for both Claude and Nova models. This prevents truncation on long transcripts and improves the natural flow of summaries while maintaining scoring consistency.
- **Scoring Calibration**: Updated the evaluation rubric to include a "Strong No Hire" category (0.0 - 2.4) and strictly enforced mathematical alignment between the `overall_score` and the final recommendation.
- **Rubric Generation**: Added strict constraints to the JD parser, enforcing 6-9 specific dimensions with controlled weight distributions (critical vs. nice-to-have) and a maximum of 3 critical deal-breakers.
- **Weighted Scoring**: Implemented a weighted average model for the `overall_score`. The evaluation prompt now explicitly instructs the AI to prioritize high-weight and critical dimensions in its final verdict.
- **Anti-Hallucination**: Introduced rigorous anti-hallucination rules requiring all claims to be grounded in verbatim transcript evidence. Scores for dimensions with missing evidence are now capped.
- **Executive Summaries**: Refined the summary format to be more direct and professional, removing redundant prefixes like "CRITICAL RISKS & GAPS" in favor of specific, prose-based risk assessment.

## [2026-04-24] — Evaluation Engine v2.1 (Alignment & Reset Fixes)

### Fixed
- **Domain Hallucination**: Completely removed all hardcoded role examples (like "Distributed Systems" or "L&D") from the rubric generation prompt. The engine is now strictly grounded in the provided JD text, ensuring accurate dimensions for any role (HR, Finance, Tech, etc.).
- **Evaluation Reset**: Implemented an automated state reset in the API handler. Uploading a new Job Description, Transcript, or Resume now clears all previous scores, recommendations, and PDF reports, preventing stale data from being displayed after a file update.
- **Syntax Correction**: Resolved a duplicate return statement in the API handler that was causing build failures.
- **Role Alignment Logic**: Simplified the semantic alignment check to be more robust and domain-aware without relying on biased examples.

## [2026-04-24] — Dashboard Redesign

### Changed
- **Visual Identity**: Completely redesigned the dashboard with a professional, "Minfy AI" branded aesthetic, moving away from standard AI-generated layouts.
- **Stat Cards**: Rebuilt stat cards with interactive states, colored icon backgrounds, and dynamic bottom progress bars that reflect the active filter state.
- **Candidate Avatars**: Implemented dynamic initials-based avatars for candidates in the evaluations table with a rotating professional color palette.
- **Interactive Filtering**:
    - Stat cards now function as direct filter toggles with visual "active" feedback (borders and glows).
    - Added an active filter chip in the table header with a quick-clear (×) option.
    - Standardized the status dropdown with custom styling to match the brand identity.
- **Layout Refinement**: Standardized spacing, typography, and borders across the dashboard to create a premium, cohesive user experience.

## [2026-04-24] — Interactive Tour System

### Added
- **Global Tour Framework**: Implemented a robust `TourProvider` and `TourContext` to manage step-by-step guidance across the entire application.
- **Context-Aware Overlays**: Created a `TourOverlay` component that dynamically highlights UI elements and provides instructional tooltips with automatic viewport clamping.
- **Multi-Step Guidance**:
    - **Dashboard**: Highlights stats, navigation, and the evaluations table.
    - **New Evaluation (Setup)**: Guides users through candidate naming, role selection, and AI model choices.
    - **New Evaluation (Uploads)**: Explains the purpose of transcripts, job descriptions, and resumes during the upload phase.
- **Replay Functionality**: Added a "Replay Guide" button (Help Circle) to the Topbar, allowing users to re-trigger instructional tours on any page at any time.
- **Cross-Page State**: Tours now persist across page transitions (e.g., from step 1 to step 2 of evaluation creation) for a seamless onboarding experience.

## [2026-04-24] — PDF Report v2 (Executive Grade)

### Changed
- **Visual Overhaul**: Completely redesigned the PDF evaluation report with a high-contrast indigo and slate professional color palette.
- **Executive Header**: Added a weighted brand header with the Minfy AI logo wordmark and automated evaluation timestamps.
- **Metrics Strip**: Implemented a four-column executive summary strip for high-level visibility into Overall Rating, JD Fit, Technical Depth, and Confidence scores.
- **Competency Visualization**: Replaced text-only breakdowns with progress-bar visualizations and score-based color coding (Green/Indigo/Amber/Red).
- **Two-Column Risk Analysis**: Reformatted Strengths and Risks into a balanced two-column layout with high-visibility iconography.
- **Executive Verdict**: Added a boxed, branded "Final Verdict" section with score-matched background shading for instant decision-making.
- **Structural Integrity**: Improved page-break logic and footer consistency across multi-page reports.

## [2026-04-24] — Tour Final

### Added
- **Bidirectional Navigation**: Integrated `prevStep` logic into the global `TourProvider`, allowing users to navigate backward through tour steps.
- **Visual Pulse Effects**: Implemented a non-destructive pulsing focus ring (`tour PulseRing`) using CSS keyframes to highlight target elements without blocking clicks.
- **Smart Tooltip Positioning**: Developed a dynamic collision-detection algorithm for tour tooltips that automatically flips positions (Top/Bottom/Left/Right) to ensure they remain within the viewport.
- **Tour Per-User Tracking**: Migrated the tour completion flag from `localStorage` to a DynamoDB-backed user preferences model. This ensures a seamless "one-and-done" tour experience that follows users across different devices and browsers.
- **Processor DB Key Fix**: Updated the evaluation processor to use the new `PK/SK` composite key format. This resolves the issue where interviews were stuck in the `QUEUED` state due to the worker being unable to locate records using the old `interview_id` primary key.
- **Critical Infrastructure Fix**: Corrected Bedrock inference profile ARNs to use the full AWS format. Optimized SQS visibility timeout to 15 minutes (6x Lambda timeout) and upgraded the evaluation processor to 1024MB RAM with a 10-minute execution window to handle complex, long-form transcripts.
- **Tour Reliability Fix**: Resolved an issue where the tour overlay would fail to render due to early measurement of target elements. Implemented a retry mechanism (up to 15 attempts) with polling for element visibility and increased initial delays to ensure page stability before activation.
- **Vignette Focus**: Replaced the full-screen dark overlay with a subtle radial vignette centered on the active element, providing focus while maintaining context.
- **First-Visit Guard**: Added persistent localStorage checks to the "New Interview" flow, ensuring the instructional tour only triggers for first-time users (while remaining manual-replayable).
- **UI Refinements**: Redesigned tour tooltips with updated typography, step indicators, and progress bars.
