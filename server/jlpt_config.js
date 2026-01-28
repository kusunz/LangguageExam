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

module.exports = {
    JLPT_READING_TYPES,
    READING_TIME_BUDGET,
    PASSAGE_LENGTH_TARGETS,
    TYPE_TITLES
};
