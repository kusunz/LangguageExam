function getDetailedGradeAnalysisRunConfig(options = {}) {
    const wrongCount = Math.max(0, ensureArray(options.wrongQuestions).length);

    return {
      // Increased: grading output is complex (Vietnamese + review_tasks + mini_lesson + extra_examples per question)
      maxTokens: wrongCount <= 1 ? 8192 : wrongCount <= 3 ? 10240 : wrongCount <= 6 ? 12288 : 14336,
      // Increased: reasoning models need more time for complex structured output
      timeoutMs: wrongCount <= 1 ? 90000 : wrongCount <= 3 ? 120000 : wrongCount <= 6 ? 150000 : 180000,
      // FIXED: OpenRouter (Nemotron) first - Gemini 2.5-flash-lite is overloaded (503)
      preferredProviders: ['openrouter', 'gemini'],
      // FIXED: Use working OpenRouter stages first, skip compat stages entirely
      preferredStageNames: [
        'openrouter-primary',
        'openrouter-secondary',
        'openrouter-router',
        'gemini-key-a',
        'gemini-key-b'
      ],
      responseProfile: {
        maxStudyPlanSteps: wrongCount <= 3 ? 2 : 3,
        maxFocusTags: wrongCount <= 3 ? 4 : 6,
        maxExamplesPerQuestion: wrongCount <= 2 ? 1 : 2,
        maxReviewTasksPerQuestion: 2,
        maxPersonalizationHints: 3,
        maxNextGoals: wrongCount <= 3 ? 2 : 3
      }
    };
  }
