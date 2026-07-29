import sys

with open(r'G:\japanesePractice\server\server.js', 'rb') as f:
    raw = f.read()
content = raw.decode('utf-8')

# Find insert point: right before "function buildTtsTextPrompt"
# (after buildSummaryGradePrompt closes)
INSERT_SEARCH = '- Output valid JSON only. No markdown. No commentary outside JSON.`;\r\n}\r\nfunction buildTtsTextPrompt'
idx = content.find(INSERT_SEARCH)
if idx == -1:
    print('ERROR: Insert point not found'); sys.exit(1)

# insert_at = position of \r\n before "function buildTtsTextPrompt"
insert_at = idx + len('- Output valid JSON only. No markdown. No commentary outside JSON.`;\r\n}')
print(f'Insert at {insert_at}')

# New functions to insert
NEW_FUNCS = (
    '\r\n'
    '\r\n'
    '// buildDetailedGradeAnalysisPrompt: used for single-call grading (<=GRADE_SPLIT_THRESHOLD wrong questions)\r\n'
    '// Same schema as buildSummaryGradePrompt - this is the combined summary+question_feedback prompt.\r\n'
    'function buildDetailedGradeAnalysisPrompt(opts) {\r\n'
    '  return buildSummaryGradePrompt(opts);\r\n'
    '}\r\n'
    '\r\n'
    '// buildMondaiFeedbackPrompt: used by runSplitGrading for per-mondai-group feedback.\r\n'
    '// Returns only question_feedback (no summary section).\r\n'
    'function buildMondaiFeedbackPrompt({\r\n'
    '  uiLocale = \'vi\',\r\n'
    '  mondaiId = \'unknown\',\r\n'
    '  mondaiName = \'Mondai\',\r\n'
    '  questions = [],\r\n'
    '  summary = {},\r\n'
    '  weakTags = [],\r\n'
    '  strongTags = [],\r\n'
    '  responseProfile = {}\r\n'
    '}) {\r\n'
    '  const locale = normalizeUiLocale(uiLocale);\r\n'
    '  const feedbackLanguage = getFeedbackLanguageName(locale);\r\n'
    '  const maxExamplesPerQuestion = Math.max(1, Number(responseProfile.maxExamplesPerQuestion || 1));\r\n'
    '  const maxReviewTasksPerQuestion = Math.max(1, Number(responseProfile.maxReviewTasksPerQuestion || 2));\r\n'
    '  const recommendation = String(summary.recommendation || \'\').trim();\r\n'
    '  const explanationStyle = summary.explanation_style || \'step_by_step\';\r\n'
    '\r\n'
    '  const questionsBlock = questions.map((q, i) =>\r\n'
    '    `[${i + 1}] id="${q.id}"\\nPrompt: ${q.prompt}\\nTags: ${ensureArray(q.tags).join(\', \') || \'(none)\'}\\nStudent chose: ${q.user_answer}\\nCorrect answer: ${q.correct_answer}\\nAuthor hint: ${q.explain_brief || \'(none)\'}${q.passage_snippet ? `\\nContext: ${q.passage_snippet}` : \'\'}`\r\n'
    '  ).join(\'\\n\\n\');\r\n'
    '\r\n'
    '  return `You are a JLPT coach giving per-question feedback in ${feedbackLanguage}.\r\n'
    'Mondai group: ${mondaiName} (id: ${mondaiId})\r\n'
    'Overall coaching style: ${explanationStyle}\r\n'
    '${recommendation ? `Overall recommendation: ${recommendation}` : \'\'}\r\n'
    'Weak tags across exam: ${uniqueStrings(weakTags, 6).join(\', \') || \'(none)\'}\r\n'
    '\r\n'
    'Grade ONLY these ${questions.length} wrong questions. Output ONLY question_feedback for their ids.\r\n'
    '\r\n'
    'QUESTIONS:\r\n'
    '${questionsBlock}\r\n'
    '\r\n'
    'Return RAW JSON ONLY:\r\n'
    '{\r\n'
    '  "question_feedback": {\r\n'
    '    "<question_id>": {\r\n'
    '      "why_wrong": "<why wrong in ${feedbackLanguage}>",\r\n'
    '      "key_point": "<core point in ${feedbackLanguage}>",\r\n'
    '      "mini_lesson": "<2-4 coaching sentences in ${feedbackLanguage}>",\r\n'
    '      "extra_examples": [{ "target": "<Japanese>", "${locale}": "<translation>" }],\r\n'
    '      "review_tasks": ["<task1>", "<task2>"]\r\n'
    '    }\r\n'
    '  }\r\n'
    '}\r\n'
    '\r\n'
    'Rules:\r\n'
    '- "why_wrong" must compare chosen answer vs correct answer.\r\n'
    '- "key_point" is a brief recall hook.\r\n'
    '- "mini_lesson" tells the learner what clue to notice next time.\r\n'
    '- Return at most ${maxReviewTasksPerQuestion} review_tasks per question.\r\n'
    '- Return at most ${maxExamplesPerQuestion} extra_examples per question.\r\n'
    '- Output valid JSON only. No markdown. No commentary.`;\r\n'
    '}\r\n'
)

content = content[:insert_at] + NEW_FUNCS + content[insert_at:]

with open(r'G:\japanesePractice\server\server.js', 'wb') as f:
    f.write(content.encode('utf-8'))
print(f'CHANGE 3 (new functions): applied, new file size {len(content)}')