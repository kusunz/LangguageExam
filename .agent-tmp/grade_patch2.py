import sys

with open(r'G:\japanesePractice\server\server.js', 'rb') as f:
    raw = f.read()
content = raw.decode('utf-8')

START_MARKER = '      if (wrongQuestions.length > 0) {\r\n        const analysisConfig = getDetailedGradeAnalysisRunConfig({'
END_OF_IF = '              .filter(Boolean);\r\n          }\r\n        });\r\n      }'

start_idx = content.find(START_MARKER)
if start_idx == -1:
    print('ERROR: START_MARKER not found'); sys.exit(1)

end_idx = content.find(END_OF_IF, start_idx + len(START_MARKER))
if end_idx == -1:
    print('ERROR: END_OF_IF not found'); sys.exit(1)
end_idx += len(END_OF_IF)

NEW_BLOCK = (
    '      if (wrongQuestions.length > 0) {\r\n'
    '        const analysisConfig = getDetailedGradeAnalysisRunConfig({\r\n'
    '          wrongQuestions,\r\n'
    '          totalCount\r\n'
    '        });\r\n'
    '        const splitThreshold = Number.parseInt(process.env.GRADE_SPLIT_THRESHOLD || \'3\', 10);\r\n'
    '        const useSplitGrading = wrongQuestions.length > splitThreshold;\r\n'
    '        const gradingExamMeta = { ...examMeta, total_score: correctCount, max_score: totalCount };\r\n'
    '        const gradingUserContext = buildUserLearningContext(userData, examMeta, uiLocale);\r\n'
    '        const sharedGradingBase = {\r\n'
    '          examMeta: gradingExamMeta,\r\n'
    '          uiLocale,\r\n'
    '          weakTags,\r\n'
    '          strongTags,\r\n'
    '          scoreByGroup,\r\n'
    '          userLearningContext: gradingUserContext,\r\n'
    '          fallbackSummary: analysisSummary,\r\n'
    '          responseProfile: analysisConfig.responseProfile,\r\n'
    '          preferredProviders: analysisConfig.preferredProviders,\r\n'
    '          preferredStageNames: analysisConfig.preferredStageNames,\r\n'
    '          temperature: 0.2\r\n'
    '        };\r\n'
    '\r\n'
    '        let analysis;\r\n'
    '        if (useSplitGrading) {\r\n'
    '          console.log(`[Grade V2] Split-grading: ${wrongQuestions.length} wrong > threshold ${splitThreshold}`);\r\n'
    '          analysis = await runSplitGrading({\r\n'
    '            wrongQuestions,\r\n'
    '            ...sharedGradingBase,\r\n'
    '            maxTokensSummary: analysisConfig.maxTokensSummary,\r\n'
    '            maxTokensMondai: analysisConfig.maxTokensMondai,\r\n'
    '            timeoutMs: analysisConfig.timeoutMs\r\n'
    '          });\r\n'
    '        } else {\r\n'
    '          console.log(`[Grade V2] Single-call grading: ${wrongQuestions.length} wrong`);\r\n'
    '          const detailedPrompt = buildDetailedGradeAnalysisPrompt({\r\n'
    '            ...sharedGradingBase,\r\n'
    '            wrongQuestions\r\n'
    '          });\r\n'
    '          const analysisResult = await runJsonTask({\r\n'
    '            task: \'explain\',\r\n'
    '            prompt: detailedPrompt,\r\n'
    '            validateResult: buildDetailedGradeAnalysisValidator(wrongQuestions.map((q) => q.id)),\r\n'
    '            maxTokens: analysisConfig.maxTokens,\r\n'
    '            timeoutMs: analysisConfig.timeoutMs,\r\n'
    '            preferredProviders: analysisConfig.preferredProviders,\r\n'
    '            preferredStageNames: analysisConfig.preferredStageNames,\r\n'
    '            temperature: 0.2\r\n'
    '          });\r\n'
    '          analysis = analysisResult?.result || {};\r\n'
    '        }\r\n'
    '\r\n'
    '        analysisSummary = {\r\n'
    '          ...analysisSummary,\r\n'
    '          ...ensureObject(analysis.summary),\r\n'
    '          weak_tags: uniqueStrings([\r\n'
    '            ...weakTags,\r\n'
    '            ...ensureArray(analysis?.summary?.weak_tags)\r\n'
    '          ], 10),\r\n'
    '          strength_tags: uniqueStrings([\r\n'
    '            ...strongTags,\r\n'
    '            ...ensureArray(analysis?.summary?.strength_tags)\r\n'
    '          ], 8),\r\n'
    '          focus_tags: uniqueStrings([\r\n'
    '            ...ensureArray(analysis?.summary?.focus_tags),\r\n'
    '            ...weakTags\r\n'
    '          ], 6)\r\n'
    '        };\r\n'
    '        const questionFeedback = ensureObject(analysis.question_feedback);\r\n'
    '        byQuestion.forEach((question) => {\r\n'
    '          const feedback = ensureObject(questionFeedback[question.id]);\r\n'
    '          if (!feedback || Object.keys(feedback).length === 0) return;\r\n'
    '\r\n'
    '          setLocalizedStringField(question, \'why_wrong\', uiLocale, feedback.why_wrong);\r\n'
    "          setLocalizedStringField(question, 'key_point', uiLocale, feedback.key_point || question.key_point?.[uiLocale] || question[`key_point_${uiLocale}`]);\r\n"
    '          setLocalizedStringField(question, \'mini_lesson\', uiLocale, feedback.mini_lesson);\r\n'
    '          setLocalizedArrayField(question, \'review_tasks\', uiLocale, feedback.review_tasks);\r\n'
    '\r\n'
    '          const examples = normalizeExtraExamples(feedback.extra_examples, uiLocale);\r\n'
    '          if (examples.length > 0) {\r\n'
    '            question.extra_examples = examples;\r\n'
    '            question.extra_examples_target = examples\r\n'
    '              .map((example) => example.target)\r\n'
    '              .filter(Boolean);\r\n'
    '          }\r\n'
    '        });\r\n'
    '      }'
)

content = content[:start_idx] + NEW_BLOCK + content[end_idx:]

with open(r'G:\japanesePractice\server\server.js', 'wb') as f:
    f.write(content.encode('utf-8'))
print(f'CHANGE 2: applied, new file size {len(content)}')