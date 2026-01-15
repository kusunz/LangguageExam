# System Test Plan & Verification Report

> **Status**: Draft / In Progress
> **Date**: 2026-01-15
> **Environment**: Local (Express + FileSystem/Neon)

---

## 1. Functional Verification (Features)

| ID | Feature | Test Scenario | Expected Result | Status |
|----|---------|---------------|-----------------|--------|
| **FUNC-01** | **Standard Mode Exam** | Select "Standard" mode, generate exam. | Generates **3-4 random reading mondai**. Time limits scaled to ~66%. | ⏳ Pending |
| **FUNC-02** | **Audio Player UI** | Scroll text while audio player is active. | Player **sticks to top** of screen (margin/padding fixed). | ⏳ Pending |
| **FUNC-03** | **Reading UI** | Open reading mondai. | **Zoom buttons** visible. Hide correctly when moving to non-reading questions. | ⏳ Pending |
| **FUNC-04** | **Grading Options** | Click "Nộp bài". | Modal appears with **Quick Grade / AI Grade** options. | ⏳ Pending |
| **FUNC-05** | **Quick Grade** | Select "Chấm nhanh". | Instant results. No AI call. Score calculated correctly. | ⏳ Pending |
| **FUNC-06** | **Mistake Book** | Check "Sổ tay" after grading. | Incorrect answers saved with **Context (Passage/Script)** and **Feedback**. | ⏳ Pending |
| **FUNC-07** | **TTS Stop** | Click "Thoát" or "Nộp bài" while audio playing. | Audio **stops immediately**. | ⏳ Pending |

---

## 2. Security Analysis (Static Analysis)

| ID | Category | Check | Implementation Status | Notes |
|----|----------|-------|-----------------------|-------|
| **SEC-AUTH-01** | Auth | Missing headers | ✅ Implemented | `authMiddleware` rejects missing headers (except demo mode). |
| **SEC-INJ-01** | Injection | SQL Injection | ✅ Implemented | `db.query` uses parameterized queries (`$1`, `$2`). |
| **SEC-XSS-01** | XSS | Stored XSS (Notebook) | ⚠️ Review Needed | Need to verify if `audioScript` or `passageText` renders raw HTML safely. |
| **SEC-RATE-01** | Abuse | Rate Limiting | ✅ Implemented | `express-rate-limit` configured (100 req/15min). |
| **SEC-OPS-01** | Ops | Secrets in Log | ⚠️ Review Needed | Check error logging in `server.js` for leak risks. |

---

## 3. Performance & Optimization Review

| ID | Category | Check | Implementation Status | Notes |
|----|----------|-------|-----------------------|-------|
| **PERF-TTS-01** | TTS | Smart Caching | ✅ Implemented | Server-side LRU cache + Browser cache logic. |
| **PERF-TTS-02** | TTS | Hybrid Streaming | ✅ Implemented | Dialogue = stream, Non-dialogue = atomic. |
| **PERF-FE-01** | UX | Progressive Loading | ✅ Implemented | `generate-group` loads exam in chunks. |
| **PERF-STO-01** | Storage | Optimized History | ✅ Implemented | Truncated context (500 chars), minimal fields in Mistake Book. |

---

## 4. Manual Test Results (Execution Log)

*Will be updated after test execution...*
