/**
 * JLPT Configuration & Structures
 * Defines the composition of test items, time budgets, and generation targets per level.
 */

// Permitted reading item types per level (Official JLPT Guidelines)
const JLPT_READING_TYPES = {
    N5: ['reading_short', 'reading_mid', 'reading_info'],
    N4: ['reading_short', 'reading_mid', 'reading_info'],
    N3: ['reading_short', 'reading_mid', 'reading_long', 'reading_info'],
    N2: ['reading_short', 'reading_mid', 'reading_long', 'reading_compare', 'reading_info'],
    N1: ['reading_short', 'reading_mid', 'reading_long', 'reading_integrated', 'reading_thematic', 'reading_info']
};

// Reading Section Time Budgets (Seconds) by Mode & Level
const READING_TIME_BUDGET = {
    // Basic: ~1/3 official time
    basic: { N5: 600, N4: 900, N3: 1200, N2: 1800, N1: 2100 },
    // Standard: ~2/3 official time
    standard: { N5: 1200, N4: 1800, N3: 2400, N2: 3600, N1: 4200 },
    // Official: Full time
    official: { N5: 1800, N4: 2700, N3: 3600, N2: 5400, N1: 6300 }
};

// Target Passage Lengths (Characters/Words) for Generation
// Note: Adjusted for practical screen reading; "Official" aligns with JLPT norms.
const PASSAGE_LENGTH_TARGETS = {
    basic: {
        reading_short: '100-150 chars',
        reading_mid: '250-350 chars',
        reading_long: '400-600 chars',
        reading_compare: '250-350 chars (each)',
        reading_info: '200-300 chars',
        reading_integrated: '400-500 chars',
        reading_thematic: '500-700 chars'
    },
    standard: {
        reading_short: '150-200 chars',
        reading_mid: '350-500 chars',
        reading_long: '600-800 chars',
        reading_compare: '350-450 chars (each)',
        reading_info: '300-450 chars',
        reading_integrated: '500-600 chars',
        reading_thematic: '700-900 chars'
    },
    official: {
        reading_short: '200 chars',
        reading_mid: '500 chars',
        reading_long: '1000 chars',
        reading_compare: '600 chars (each)',
        reading_info: '600 chars',
        reading_integrated: '800 chars',
        reading_thematic: '1000 chars'
    }
};

// Mapping internal item_type to user-friendly titles
const TYPE_TITLES = {
    reading_short: { vi: 'Đoạn văn ngắn', ja: '短文' },
    reading_mid: { vi: 'Đoạn văn trung bình', ja: '中文' },
    reading_long: { vi: 'Đoạn văn dài', ja: '長文' },
    reading_compare: { vi: 'So sánh', ja: '比較' },
    reading_info: { vi: 'Tìm kiếm thông tin', ja: '情報検索' },
    reading_integrated: { vi: 'Đọc hiểu tổng hợp', ja: '統合理解' },
    reading_thematic: { vi: 'Đọc hiểu chủ đề', ja: '主張理解' }
};


// ===== HSK (Chinese) =====
// Per-language reading item types and budgets. JLPT block above is intentionally untouched.
const HSK_READING_TYPES = {
    HSK1: ['reading_cloze', 'reading_sentence'],
    HSK2: ['reading_cloze', 'reading_sentence', 'reading_comprehension'],
    HSK3: ['reading_cloze', 'reading_sentence', 'reading_comprehension'],
    HSK4: ['reading_cloze', 'reading_sentence', 'reading_comprehension'],
    HSK5: ['reading_cloze', 'reading_sentence', 'reading_comprehension'],
    HSK6: ['reading_cloze', 'reading_sentence', 'reading_comprehension']
};

// Reading Section Time Budgets (Seconds) by Mode & HSK Level.
// Derived as ~1/3, ~2/3, full of the official reading section time per level.
const HSK_TIME_BUDGET = {
    basic:    { HSK1: 500, HSK2: 600, HSK3: 700, HSK4: 800, HSK5: 1000, HSK6: 1300 },
    standard: { HSK1: 850, HSK2: 1000, HSK3: 1200, HSK4: 1600, HSK5: 2000, HSK6: 2600 },
    official: { HSK1: 1200, HSK2: 1500, HSK3: 1800, HSK4: 2400, HSK5: 3000, HSK6: 3900 }
};

// HSK passage length targets (characters) per mode per reading type.
const HSK_PASSAGE_LENGTHS = {
    basic: {
        reading_cloze: '50-80 chars',
        reading_sentence: '80-120 chars',
        reading_comprehension: '150-250 chars'
    },
    standard: {
        reading_cloze: '80-120 chars',
        reading_sentence: '120-180 chars',
        reading_comprehension: '250-400 chars'
    },
    official: {
        reading_cloze: '120-180 chars',
        reading_sentence: '180-280 chars',
        reading_comprehension: '400-650 chars'
    }
};

// HSK user-friendly titles (vi + zh).
const HSK_TYPE_TITLES = {
    reading_cloze: { vi: 'Dien tu', zh: 'tiancun' },
    reading_sentence: { vi: 'Chen cau', zh: 'xuanju' },
    reading_comprehension: { vi: 'Hieu noi dung', zh: 'yuedulv' }
};


// ===== Generic, language-agnostic registry =====
// Adding a new language only requires appending an entry below plus the per-type
// constants above. Existing JLPT/HSK exports stay stable for callers and tests.
const EXAM_CONFIGS = {
    jlpt: {
        language: 'ja-JP',
        readingTypes: JLPT_READING_TYPES,
        timeBudget: READING_TIME_BUDGET,
        passageTargets: PASSAGE_LENGTH_TARGETS,
        typeTitles: TYPE_TITLES
    },
    hsk: {
        language: 'zh-CN',
        readingTypes: HSK_READING_TYPES,
        timeBudget: HSK_TIME_BUDGET,
        passageTargets: HSK_PASSAGE_LENGTHS,
        typeTitles: HSK_TYPE_TITLES
    }
};

// Returns the config block for a given exam type (defaults to JLPT when unknown).
function getExamConfig(examType = 'jlpt') {
    const key = String(examType || 'jlpt').trim().toLowerCase();
    return EXAM_CONFIGS[key] || EXAM_CONFIGS.jlpt;
}

module.exports = {
    // JLPT (kept for backward compatibility with existing tests and call sites)
    JLPT_READING_TYPES,
    READING_TIME_BUDGET,
    PASSAGE_LENGTH_TARGETS,
    TYPE_TITLES,
    // HSK
    HSK_READING_TYPES,
    HSK_TIME_BUDGET,
    HSK_PASSAGE_LENGTHS,
    HSK_TYPE_TITLES,
    // Generic
    EXAM_CONFIGS,
    getExamConfig
};

