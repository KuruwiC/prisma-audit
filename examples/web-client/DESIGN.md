# Commons design system

Commons is the demo client for prisma-audit: a small social feed whose every write leaves a trace.
The design shows two views of the same writes side by side: what people see, and what the
database recorded.

## Principles

1. **Two layers.** The social app is a light, quiet surface. The audit trail is a dark rail
   beside it. A reader can always tell the human view from the machine view by the surface
   alone.
2. **Hue means aggregate.** Color is spent on one thing only: the aggregate a row belongs to.
   User, Post, Comment and Tag each own a hue, used the same way in the feed, the rail, the
   history drawer and the audit log. Nothing else is colored, apart from the system accent: the
   focus ring, text selection and the logo use the Post blue, as no aggregate is shown there.
3. **Shape means action.** Create, update and delete are told apart by a glyph and a stroke
   (`+` filled, `~` outlined, `−` dashed), never by hue, so the aggregate hue stays readable.
4. **One mutation, many perspectives.** The signature element is the fan-out: one written row
   branches into the aggregates it was recorded under. Everything around it stays plain.
5. **Monospace is for code.** Prisma calls, paths, ids and JSON use the mono face. Labels,
   names and sentences never do.
6. **Motion answers actions.** New rows slide into the rail after the viewer writes something;
   a rolled-back request collapses. There is no ambient animation, and
   `prefers-reduced-motion` turns the slides off.

## Tokens

Defined once in `src/styles.css` under `@theme`, so each is also a Tailwind utility
(`bg-paper`, `text-ink-muted`, `border-line`, `text-agg-post`, ...).

### Color

| Token            | Value     | Role                                   |
| ---------------- | --------- | -------------------------------------- |
| `paper`          | `#F2F4F7` | App background                          |
| `surface`        | `#FFFFFF` | Feed sheet, inputs, dialogs             |
| `ink`            | `#1A2233` | Text, primary buttons                   |
| `ink-muted`      | `#5D6679` | Secondary text                          |
| `line`           | `#DCE1EA` | Dividers and input borders              |
| `trace`          | `#151C2E` | Audit rail background                   |
| `trace-raised`   | `#1E2742` | Rows inside the rail                    |
| `trace-line`     | `#2E3A5C` | Rail dividers and branch lines          |
| `trace-ink`      | `#E6EAF5` | Rail text                               |
| `trace-muted`    | `#8D98B6` | Rail secondary text                     |
| `danger`         | `#B42318` | Destructive confirmations, errors       |

Aggregate hues, each with a light-surface value and a value for the dark rail:

| Aggregate | On `surface` (`agg-*`) | On `trace` (`agg-*-glow`) |
| --------- | ---------------------- | ------------------------- |
| User      | `#6D44E8`              | `#B6A2FF`                 |
| Post      | `#1A6FD1`              | `#7DB9FF`                 |
| Comment   | `#0B8A7B`              | `#62D5C4`                 |
| Tag       | `#A86A07`              | `#F0C066`                 |

`agg-user-tint` (`#F0ECFD`) is the opaque avatar fill: the User hue at 10% on white, kept opaque
so an avatar looks the same on light surfaces and on the dark active chip.

Entities that are never an aggregate root (Profile, PostTag, PostLike) are drawn in the
neutral ink of their surface.

### Type

- **Schibsted Grotesk** (variable) for everything a person reads: UI, posts, names.
- **Martian Mono** (variable, `wdth` 75, set at 0.8em of the surrounding text) for code, ids, paths and JSON.

Scale (ratio 1.2 from a 15px body): `12`, `13`, `15`, `18`, `22`, `27`. Body line height 1.5;
headings 1.2 with `-0.01em` tracking. Sentence case everywhere, no all-caps labels.

### Text roles

Every piece of text is either prose or a label.

- **Prose** wraps: posts, comments, quotes, bios, activity sentences, headings.
- **A label** never wraps: names, times, counts, tags, chip text, button text, request lines. It
  keeps its width (`label`: no wrap, no shrink), or truncates with an ellipsis where space is
  short (`truncate` with `min-w-0`). A name inside a sentence uses `label-inline`, which keeps it
  whole and cuts it only when it alone is wider than the line.

The distinction matters most for Japanese: a line may break between any two characters, so a
label in a shrinking flex row is otherwise squeezed to one character per line.

### Space, radius, depth

- Spacing follows the 4px grid of Tailwind's default scale.
- Radius has three steps by size: `6px` for chips and small controls, `10px` for inputs and
  buttons, `16px` for sheets and dialogs. Pills (`9999px`) are kept for aggregate chips.
- Depth: the feed is one sheet with hairline dividers between posts.
  Only what floats over the page casts a shadow: dialogs, the history drawer, and the audit trail
  sheet and its button on narrow screens.

## Layout

```
┌ Commons ─ Feed  Audit log ───────────────────── Acting as (M)(T)(P) ┐
├─────────────────────────────────────┬───────────────────────────────┤
│ feed sheet (max 620px)              │ audit rail (420px, sticky)    │
│  composer                           │  POST /api/posts      6 rows  │
│  post                               │   + Post  ─┬─ Post            │
│  post                               │            └─ User            │
│                                     │   + PostTag ─┬─ Post          │
│                                     │              └─ Tag           │
└─────────────────────────────────────┴───────────────────────────────┘
```

Content is left aligned. Below 1024px the rail becomes a bottom sheet opened from a
"Audit trail" button that counts the requests written since it was last opened.

## Components

| Component        | File                                   | Notes                                              |
| ---------------- | -------------------------------------- | -------------------------------------------------- |
| `Button`         | `components/ui/button.tsx`             | `primary` (ink), `quiet`, `danger`; 10px radius    |
| `Avatar`         | `components/ui/avatar.tsx`             | Initials; the ring takes the User hue              |
| `AggregateChip`  | `components/ui/aggregate-chip.tsx`     | Hue dot plus label; `tone="light" \| "trace"`        |
| `ActionMark`     | `components/ui/action-mark.tsx`        | `+` / `~` / `−` glyph in its stroke style          |
| `FanOut`         | `components/trace/fan-out.tsx`         | One mutation and the aggregates it branches into   |
| `ChangeList`     | `components/trace/change-list.tsx`     | Field diffs, redacted values shown as a lock       |
| `Drawer`         | `components/ui/drawer.tsx`             | Native `<dialog>`, right side, Escape closes       |
| `ActivityFeed`   | `components/trace/activity-feed.tsx`        | One sentence per request, from `lib/activity.ts`   |
| `ConfigPage`     | `features/config/config-page.tsx`      | `audit.config.ts` as is, split by `lib/config-source.ts` |

## Activity sentences

An activity is one request, not one row. `lib/activity.ts` folds a request's rows by the aggregate
mapping: a mutation recorded under another mutation's entity belongs to it, so a post carries the
tags linked while publishing it and a deleted post the comments removed with it. The only
hand-written knowledge is an entity rank for the rare request with two roots, and one verb
template per entity. Sentences read the contexts captured at write time (a comment keeps the
title its post had), never the current data, and name the viewed aggregate "this post" or
"this account". A timeline read under one aggregate sees only that aggregate's rows and phrases
what they show.

## Copy

Plain verbs that name what happens: "Post", "Save profile", "Reset demo data". A rolled-back
request says what happened and what was left behind: "Rolled back. Nothing was written,
including the audit rows." Empty states tell the reader what to do next.
