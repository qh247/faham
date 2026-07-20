# faham

**English** · [Bahasa Malaysia](README.ms.md) · [中文](README.zh.md)

A timeline of Malaysian public policy.

## Status

Scaffolding stage. No data collected yet — `data/events.json` is an empty array.

## What we intend to build

- Daily crawling of publicly accessible Malaysian news sources to generate candidate entries
- Users can submit additions and corrections
- Every claim must carry a source; contested events must show both sides — enforced by database constraints, not by good intentions
- Fairer methods of inclusion and review are still being worked out

## Structure

```
index.html          Frontend (single file, no framework, no build step)
data/events.json    Event data (exported from the database, or maintained by hand)
db/schema.sql       Database schema · PostgreSQL
docs/erd.md         Entity-relationship diagrams
docs/governance.md  Inclusion criteria and review process
```

Local preview requires an HTTP server (opening the file directly won't load the JSON):

```bash
python3 -m http.server 8000
```

## Licence

- **Code**: AGPL-3.0 — free to use and modify; if you run it as a network service, you must publish your source too
- **Content and data**: CC BY-SA 4.0 — attribution required, derivatives keep the same licence

Original sources cited in each event remain the property of their respective rights holders; this repository only indexes and links to them.

## Note

This project currently generates no revenue. If server and maintenance costs need covering later, some form of income may be introduced; that will be stated here when it happens.
