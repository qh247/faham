# faham · Inclusion Criteria and Governance

**English** · [Bahasa Malaysia](governance.ms.md) · [中文](governance.zh.md)

> **This document exists before any data does.**
> If the rules were written after the data, anyone could argue they were tailored to fit an
> existing position. So: publish the criteria first, then collect the first entry.
> The edit history of this document is equally public.

---

## 1. What this archive collects

An event must satisfy **all** of the following:

1. **Public relevance** — it concerns public policy, public funds, elections, or the official
   conduct of public officeholders. Private life is out of scope.
2. **Verifiable** — at least **2 independent sources**, of which at least 1 is an official
   document, court record, parliamentary record, or statistical dataset.
   "Independent" means different organisations; several outlets under one group republishing
   the same wire copy counts as 1.
3. **Actual effect** — it changed a regulation, budget, price, right, or election outcome.
   A verbal statement alone does not become its own entry, but may be recorded as a *claim*
   attached to an existing event.
4. **Clear timing** — locatable to a day, month, or a defined date range.

### Explicitly not collected

- Unverified rumour, anonymous tip-offs, "according to sources"
- Personal privacy, family members, health status (unless directly tied to official conduct
  and already part of public judicial proceedings)
- Speculation about motive ("what he really wanted was…") — record conduct and consequences only
- Any **figure without a source**. Better to leave it blank and mark "source pending" than to
  fill in a number that merely looks plausible

---

## 2. Additional requirements for contested events

Events flagged `contested` (touching ethnicity, religion, royalty, cases under trial, or
inter-party conflict) must pass `check_publishable()` before release:

- Claims from **both supporting and opposing sides must exist**, each with sources
- At least 2 independent sources
- If any claim lacks a source, the entire event cannot be published

> This is not editorial self-discipline; it is a database function.
> Anyone can run the query themselves to verify it.

---

## 3. How the first batch is decided (avoiding a built-in slant)

The biggest risk: if the first 30 events are all failures of the current government, the archive
is a partisan instrument from the moment it is born, and no amount of later correction washes
that off.

### Quota rules (mandatory)

The first batch is **no fewer than 24 entries**, distributed across governing periods:

| Period | Minimum |
|---|---|
| Barisan Nasional era (around 2015: GST, 1MDB, etc.) | 5 |
| Pakatan Harapan 1.0 (2018–2020) | 4 |
| Perikatan Nasional / transition (2020–2022) | 4 |
| Unity Government (2022–present) | 5 |
| Cross-period structural issues (subsidies, tax base, debt, electoral system) | 6 |

Within each period, entries about **policy achievements** and about **policy costs** must each
number at least 2 — the record cannot show only one administration's wins and another's failures.

### Selection process

1. The candidate pool comes from open solicitation plus an editorial draft;
   **the candidate list is published first**, including entries not selected and the reasons why
2. Each entry is checked against Section 1 item by item; unmet criteria mean exclusion
3. At least 2 reviewers approve independently (see Section 4)
4. When the first batch is published, a **"what we know we're missing" list** is published
   alongside it — for example, insufficient coverage of East Malaysian, Orang Asli, labour and
   migrant-worker issues, listed explicitly as outstanding

### Source of the first seed entries

The first entries draw on completed multi-source cross-checking (Election Commission official
results, Ministry of Finance press releases, LHDN official timelines, ISEAS, World Bank, Bernama,
mainstream media, etc.), but **each must still go through the submission–review process**:
no back door for ourselves; the process runs and leaves a record from the very first entry.

---

## 4. Who reviews

| Tier | How it is obtained | Permissions |
|---|---|---|
| Guest | No registration | Read-only; at most 2 comments per post per 24 hours (human verification required) |
| Verified | Email verified | No comment cooldown; may submit corrections |
| Trusted | Account ≥30 days + good conduct record + ≥1 claim marked "source reliable" | May submit events and claims |
| Reviewer | **By invitation** from an existing reviewer or editor | May vote on submissions (reasons required) |
| Editor | As above; very few people | May publish; may handle reports |

**Review panel diversity**: the 2 reviewers on any one submission must not share the same
self-declared political leaning (`users.alignment_note` is voluntary and used only for pairing,
never to restrict permissions).
Reviewers' decisions are all public — reviewers themselves can be challenged.

---

## 5. Guarantees that can be verified externally

Nobody is asked to trust the operator. All of the following can be checked independently:

1. **Daily public export** — the full dataset (`export_events` view) is exported as JSON and
   pushed to a public repository. Anyone who disagrees with this platform can take the whole
   thing, analyse it themselves, or build a rival. **Exit cost is zero.**
2. **Revision snapshots** — the `revisions` table records state at every change; any sentence on
   the page can be traced to who changed it, when, and on what basis.
3. **Neutrality self-check** — the `event_balance` view and `check_publishable()` function are
   public; anyone can run them to verify that both sides really are presented.
4. **Corrections ledger** — the `corrections` table is public, including **unresolved** requests.
   A platform that displays only "already fixed" is cherry-picking.

---

## 6. How these rules change

Amending this document requires: proposal → public notice of no less than 14 days → agreement
from at least 2 editors and 2 reviewers → recorded reasons.
All historical versions are retained in git.

---

## 7. Known limitations (stated honestly)

- Editors and reviewers are currently very few, and not diverse enough. This is the single
  biggest present weakness; it is not concealed.
- Coverage in Chinese is stronger than in Malay or Tamil. This structurally tilts the archive
  towards a Chinese-community perspective — multilingual support is built into the data
  structure, but filling in the content needs more contributors.
- The "verifiable" standard favours events with written records, and will systematically
  under-count oral, rural, and informal-economy matters.
- This platform does not arbitrate facts. It presents each side's claims and sources; it does
  not declare who is right.
