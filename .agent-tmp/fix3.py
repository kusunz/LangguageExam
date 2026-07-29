import sys

with open(r'G:\japanesePractice\server\server.js', 'rb') as f:
    raw = f.read()
content = raw.decode('utf-8')

# =============================================================
# FIX 4: Vercel timeout guard around AI grading
# Wrap the grading section in a race vs GRADE_TIMEOUT_MS.
# If timeout fires, skip AI enrichment and return fallback result.
# =============================================================
old4 = (
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
    "            task: 'explain',\r\n"
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
)
new4 = (
    '        const gradeTimeoutMs = Number.parseInt(process.env.GRADE_TIMEOUT_MS || String(analysisConfig.timeoutMs), 10);\r\n'
    '        let gradeTimedOut = false;\r\n'
    '        let analysis;\r\n'
    '\r\n'
    '        const gradeTimeoutPromise = new Promise(resolve =>\r\n'
    '          setTimeout(() => { gradeTimedOut = true; resolve(null); }, gradeTimeoutMs)\r\n'
    '        );\r\n'
    '\r\n'
    '        const gradeWorkPromise = useSplitGrading\r\n'
    '          ? (() => {\r\n'
    '              console.log(`[Grade V2] Split-grading: ${wrongQuestions.length} wrong > threshold ${splitThreshold}`);\r\n'
    '              return runSplitGrading({\r\n'
    '                wrongQuestions,\r\n'
    '                ...sharedGradingBase,\r\n'
    '                maxTokensSummary: analysisConfig.maxTokensSummary,\r\n'
    '                maxTokensMondai: analysisConfig.maxTokensMondai,\r\n'
    '                timeoutMs: analysisConfig.timeoutMs\r\n'
    '              });\r\n'
    '            })()\r\n'
    '          : (() => {\r\n'
    '              console.log(`[Grade V2] Single-call grading: ${wrongQuestions.length} wrong`);\r\n'
    '              const detailedPrompt = buildDetailedGradeAnalysisPrompt({\r\n'
    '                ...sharedGradingBase,\r\n'
    '                wrongQuestions\r\n'
    '              });\r\n'
    '              return runJsonTask({\r\n'
    "                task: 'explain',\r\n"
    '                prompt: detailedPrompt,\r\n'
    '                validateResult: buildDetailedGradeAnalysisValidator(wrongQuestions.map((q) => q.id)),\r\n'
    '                maxTokens: analysisConfig.maxTokens,\r\n'
    '                timeoutMs: analysisConfig.timeoutMs,\r\n'
    '                preferredProviders: analysisConfig.preferredProviders,\r\n'
    '                preferredStageNames: analysisConfig.preferredStageNames,\r\n'
    '                temperature: 0.2\r\n'
    '              }).then(r => r?.result || {});\r\n'
    '            })();\r\n'
    '\r\n'
    '        const gradeRace = await Promise.race([gradeWorkPromise, gradeTimeoutPromise]).catch(err => {\r\n'
    '          console.warn(`[Grade V2] AI grading error (will use fallback): ${err.message}`);\r\n'
    '          return null;\r\n'
    '        });\r\n'
    '\r\n'
    '        if (gradeTimedOut || gradeRace === null) {\r\n'
    '          console.warn(`[Grade V2] AI grading ${gradeTimedOut ? "timed out" : "failed"} – returning fallback result without AI enrichment`);\r\n'
    '          analysis = {};\r\n'
    '        } else {\r\n'
    '          analysis = gradeRace;\r\n'
    '        }\r\n'
    '\r\n'
)
if old4 in content:
    content = content.replace(old4, new4, 1)
    print('FIX 4 (Vercel timeout guard): applied')
else:
    print('FIX 4: NOT FOUND - checking line endings')
    # Try LF
    old4lf = old4.replace('\r\n', '\n')
    new4lf = new4.replace('\r\n', '\n')
    if old4lf in content:
        content = content.replace(old4lf, new4lf, 1)
        print('FIX 4 (LF): applied')
    else:
        print('FIX 4: still NOT FOUND')

with open(r'G:\japanesePractice\server\server.js', 'wb') as f:
    f.write(content.encode('utf-8'))
print('server.js saved')
